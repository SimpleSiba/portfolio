// Interactive Brokers CSV import (pure functions, no DOM).
// Supports the Activity Statement CSV (Performance & Reports → Statements → Activity → CSV)
// and a Flex Query trades CSV. Reads stock trades, USD.ILS conversions, dividends and US tax withheld.

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const num = (s) => {
  if (s == null) return NaN;
  const v = Number(String(s).replace(/,/g, '').trim());
  return s === '' ? NaN : v;
};
export function isoDate(s) {
  const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const tickerFromDesc = (d) => (String(d).match(/^\s*([A-Z0-9.\-]+)\s*\(/) || [])[1] || null;

function tradeToTxn({ assetClass, currency, symbol, dateRaw, qty, price, comm }, out, skipped) {
  const date = isoDate(dateRaw);
  if (!date || !isFinite(qty) || !isFinite(price)) { skipped.push(`Unreadable trade row: ${symbol} ${dateRaw}`); return; }
  const fees = Math.abs(isFinite(comm) ? comm : 0);
  const key = `${symbol}|${dateRaw}|${qty}|${price}`;
  if (/^(stocks?|stk|etf)$/i.test(assetClass)) {
    if (currency && currency !== 'USD') { skipped.push(`${symbol}: ${currency} trades not supported`); return; }
    const base = { ticker: symbol.toUpperCase(), date, shares: Math.abs(qty), priceUsd: price, feesUsd: fees, source: 'ibkr' };
    if (qty > 0) out.push({ id: 'ib-' + hash('buy|' + key), type: 'buy', ...base });
    else if (qty < 0) out.push({ id: 'ib-' + hash('sell|' + key), type: 'sell', ...base });
  } else if (/^(forex|cash)$/i.test(assetClass)) {
    if (symbol.toUpperCase() !== 'USD.ILS') { skipped.push(`Currency pair ${symbol} not supported`); return; }
    // Quantity = USD bought (negative = USD sold back), price = ILS per USD
    out.push({ id: 'ib-' + hash('fx|' + key), type: 'fx', date, usd: qty, ils: qty * price, source: 'ibkr' });
  } else skipped.push(`${assetClass} ${symbol} not supported`);
}

function parseActivity(rows) {
  const headers = {};
  const out = [], skipped = [];
  const divs = new Map(); // ticker|date -> {gross, tax}
  for (const r of rows) {
    const [section, kind] = r;
    if (kind === 'Header') { headers[section] = r.slice(2); continue; }
    if (kind !== 'Data' || !headers[section]) continue;
    const h = headers[section];
    const v = (name) => { const i = h.indexOf(name); return i < 0 ? undefined : r[i + 2]; };
    if (section === 'Trades') {
      const disc = v('DataDiscriminator');
      if (disc && !/^(Order|Trade|Execution)$/i.test(disc)) continue; // skip ClosedLot etc.
      tradeToTxn({
        assetClass: v('Asset Category') || '', currency: v('Currency'), symbol: v('Symbol') || '',
        dateRaw: v('Date/Time'), qty: num(v('Quantity')), price: num(v('T. Price')),
        comm: num(v('Comm/Fee') ?? v('Comm in USD')),
      }, out, skipped);
    } else if (section === 'Dividends' || section === 'Withholding Tax') {
      const cur = v('Currency');
      if (!cur || /^total/i.test(cur)) continue;
      const desc = v('Description') || '';
      const tk = tickerFromDesc(desc), date = isoDate(v('Date')), amt = num(v('Amount'));
      if (!tk || !date || !isFinite(amt)) continue;
      if (cur !== 'USD') { skipped.push(`${tk}: ${cur} dividend not supported`); continue; }
      const k = `${tk}|${date}`;
      const d = divs.get(k) || { ticker: tk, date, gross: 0, tax: 0 };
      if (section === 'Dividends') d.gross += amt; else d.tax += -amt;
      divs.set(k, d);
    }
  }
  for (const d of divs.values()) {
    if (Math.abs(d.gross) < 1e-9) continue;
    out.push({ id: 'ib-' + hash(`div|${d.ticker}|${d.date}|${d.gross.toFixed(4)}`), type: 'div', ticker: d.ticker, date: d.date,
      grossUsd: +d.gross.toFixed(4), taxUsd: +d.tax.toFixed(4), source: 'ibkr' });
  }
  return { txns: out, skipped, format: 'Activity Statement' };
}

function parseFlex(rows) {
  const h = rows[0];
  const out = [], skipped = [];
  const col = (...names) => names.map((n) => h.indexOf(n)).find((i) => i >= 0);
  const c = { sym: col('Symbol'), ac: col('AssetClass', 'Asset Class'), cur: col('CurrencyPrimary', 'Currency'), date: col('TradeDate', 'Date/Time', 'DateTime', 'Trade Date'),
    qty: col('Quantity'), price: col('TradePrice', 'T. Price', 'Price'), comm: col('IBCommission', 'Commission', 'Comm/Fee') };
  for (const r of rows.slice(1)) {
    if (r.length < 3 || r[c.sym] === 'Symbol') continue;
    tradeToTxn({ assetClass: c.ac != null ? r[c.ac] : 'STK', currency: c.cur != null ? r[c.cur] : 'USD', symbol: r[c.sym] || '',
      dateRaw: r[c.date], qty: num(r[c.qty]), price: num(r[c.price]), comm: c.comm != null ? num(r[c.comm]) : 0 }, out, skipped);
  }
  return { txns: out, skipped, format: 'Flex Query' };
}

export function parseIbkr(text) {
  text = String(text).replace(/^[\uFEFF\u200B\s]+/, '');
  // Some spreadsheet apps re-save CSVs with semicolons
  const first = text.split(/\r?\n/, 1)[0] || '';
  if (!first.includes(',') && first.includes(';')) text = text.replace(/;/g, ',');
  const rows = parseCsv(text).map((r) => r.map((c, i) => (i < 2 ? c.trim() : c)));
  if (!rows.length) throw new Error('The file is empty');
  if (rows.some((r) => r[1] === 'Header')) return parseActivity(rows);
  const h = rows[0];
  if (h.includes('Symbol') && h.includes('Quantity') && (h.includes('TradePrice') || h.includes('T. Price') || h.includes('Price'))) return parseFlex(rows);
  throw new Error(`This doesn’t look like an Interactive Brokers CSV (Activity Statement or Flex Query). It starts with: “${first.slice(0, 60)}”`);
}

// Decide what an import changes. Manual buys (not from IBKR) that match an imported day's buys
// for the same ticker and total shares are replaced by the exact IBKR versions.
export function planImport(existing, parsed) {
  const have = new Set(existing.map((t) => t.id));
  const fresh = parsed.filter((t) => !have.has(t.id));
  const duplicates = parsed.length - fresh.length;
  const manual = new Map();
  for (const t of existing) {
    if ((t.type || 'buy') !== 'buy' || String(t.id).startsWith('ib-')) continue;
    const k = `${t.ticker}|${t.date}`;
    const m = manual.get(k) || { ids: [], shares: 0 };
    m.ids.push(t.id); m.shares += t.shares; manual.set(k, m);
  }
  const imported = new Map();
  for (const t of fresh) if (t.type === 'buy') { const k = `${t.ticker}|${t.date}`; imported.set(k, (imported.get(k) || 0) + t.shares); }
  const removeIds = [];
  for (const [k, shares] of imported) {
    const m = manual.get(k);
    if (m && Math.abs(m.shares - shares) < 1e-6) removeIds.push(...m.ids);
  }
  const counts = { buy: 0, sell: 0, div: 0, fx: 0 };
  for (const t of fresh) counts[t.type]++;
  return { add: fresh, removeIds, duplicates, counts };
}
