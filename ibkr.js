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
// Spreadsheet date serial (days since 1899-12-30) -> Date, used when a CSV went through Excel/Google Sheets.
const serialToDate = (n) => new Date(Math.round((n - 25569) * 86400) * 1000);
const isSerial = (s) => /^\d{5}(\.\d+)?$/.test(String(s).trim()) && +s > 20000 && +s < 80000;
export function isoDate(s) {
  if (isSerial(s)) return serialToDate(+s).toISOString().slice(0, 10);
  const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function timeOf(s) {
  if (isSerial(s)) return serialToDate(+s).toISOString().slice(11, 19);
  const m = String(s || '').match(/(\d{1,2}):(\d{2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}` : '';
}
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// "January 1, 2026 - October 13, 2026" -> "2026-10-13" (also handles a single date)
export function periodEnd(s) {
  const parts = String(s || '').split(' - ');
  const last = parts[parts.length - 1].trim();
  const iso = isoDate(last);
  if (iso && /\d{4}-\d{2}-\d{2}/.test(last)) return iso;
  const m = last.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  return mo < 0 ? null : `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
const tickerFromDesc = (d) => (String(d).match(/^\s*([A-Z0-9.\-]+)\s*\(/) || [])[1] || null;

function tradeToTxn({ assetClass, currency, symbol, dateRaw, qty, price, comm }, out, skipped) {
  const date = isoDate(dateRaw);
  if (!date || !isFinite(qty) || !isFinite(price)) { skipped.push(`Unreadable trade row: ${symbol} ${dateRaw}`); return; }
  const fees = Math.abs(isFinite(comm) ? comm : 0);
  // ID from normalised values, so the same trade gets the same ID whether it came from a CSV or a spreadsheet copy
  const key = `${symbol.toUpperCase()}|${date}T${timeOf(dateRaw)}|${qty}|${price}`;
  if (/^(stocks?|stk|etf)$/i.test(assetClass)) {
    if (currency && currency !== 'USD') { skipped.push(`${symbol}: ${currency} trades not supported`); return; }
    const base = { ticker: symbol.toUpperCase(), date, time: timeOf(dateRaw), shares: Math.abs(qty), priceUsd: price, feesUsd: fees, source: 'ibkr' };
    if (qty > 0) out.push({ id: 'ib-' + hash('buy|' + key), type: 'buy', ...base });
    else if (qty < 0) out.push({ id: 'ib-' + hash('sell|' + key), type: 'sell', ...base });
  } else if (/^(forex|cash)$/i.test(assetClass)) {
    if (symbol.toUpperCase() !== 'USD.ILS') { skipped.push(`Currency pair ${symbol} not supported`); return; }
    // Quantity = USD bought (negative = USD sold back), price = ILS per USD
    out.push({ id: 'ib-' + hash('fx|' + key), type: 'fx', date, time: timeOf(dateRaw), usd: qty, ils: qty * price, source: 'ibkr' });
  } else skipped.push(`${assetClass} ${symbol} not supported`);
}

function parseActivity(rows) {
  const headers = {};
  const out = [], skipped = [];
  const divs = new Map(); // ticker|date -> {gross, tax}
  let asOf = null, periodFrom = null;
  const positions = {};
  for (const r of rows) {
    const [section, kind] = r;
    if (section === 'Statement' && kind === 'Data' && r[2] === 'Period') { asOf = periodEnd(r[3]); periodFrom = periodEnd(String(r[3]).split(' - ')[0]); }
    if (kind === 'Header') { headers[section] = r.slice(2); continue; }
    if (kind !== 'Data' || !headers[section]) continue;
    const h = headers[section];
    const v = (name) => { const i = h.indexOf(name); return i < 0 ? undefined : r[i + 2]; };
    if (section === 'Open Positions') {
      if (v('DataDiscriminator') === 'Summary' && /^stocks?$/i.test(v('Asset Category') || '')) positions[(v('Symbol') || '').toUpperCase()] = num(v('Quantity'));
      continue;
    }
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
  return { txns: out, skipped, format: 'Activity Statement', period: asOf && periodFrom ? { from: periodFrom, to: asOf } : null, positions: asOf ? { asOf, shares: positions } : null };
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
  return { txns: out, skipped, format: 'Flex Query', positions: null };
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
export function planImport(existing, parsed, period = null) {
  // The period the file covers (from the statement header, else the span of its transactions)
  const dates = parsed.map((t) => t.date).sort();
  const span = period || (dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null);
  const have = new Set(existing.map((t) => t.id));
  const fresh = parsed.filter((t) => !have.has(t.id));
  const duplicates = parsed.length - fresh.length;
  const isManual = (t) => !String(t.id).startsWith('ib-');
  const manual = new Map();
  for (const t of existing) {
    if ((t.type || 'buy') !== 'buy' || !isManual(t)) continue;
    const k = `${t.ticker}|${t.date}`;
    const m = manual.get(k) || { ids: [], shares: 0, date: t.date, ticker: t.ticker };
    m.ids.push(t.id); m.shares += t.shares; manual.set(k, m);
  }
  const imported = new Map();
  for (const t of fresh) if (t.type === 'buy') {
    const k = `${t.ticker}|${t.date}`;
    const g = imported.get(k) || { shares: 0, date: t.date, ticker: t.ticker };
    g.shares += t.shares; imported.set(k, g);
  }
  const removeIds = [];
  const matched = new Set();
  for (const [k, g] of imported) {
    const m = manual.get(k);
    if (m && Math.abs(m.shares - g.shares) < 1e-6) { removeIds.push(...m.ids); matched.add(k); }
  }
  // Same stock and shares, dates up to 3 days apart (e.g. settlement date vs trade date): ask the user.
  const near = [];
  const DAY = 864e5;
  for (const [mk, m] of manual) {
    if (removeIds.includes(m.ids[0])) continue;
    for (const [ik, g] of imported) {
      if (matched.has(ik) || g.ticker !== m.ticker || Math.abs(g.shares - m.shares) > 1e-6) continue;
      const gap = Math.abs(Date.parse(g.date) - Date.parse(m.date)) / DAY;
      if (gap > 0 && gap <= 3) { near.push({ ids: m.ids, ticker: m.ticker, shares: m.shares, manualDate: m.date, ibkrDate: g.date }); matched.add(ik); break; }
    }
  }
  // "IBKR is the master" only removes hand entries inside the file's period — later or earlier ones stay
  const manualIds = existing.filter((t) => isManual(t) && (t.type || 'buy') !== 'fx' && !removeIds.includes(t.id)
    && span && t.date >= span.from && t.date <= span.to).map((t) => t.id);
  const counts = { buy: 0, sell: 0, div: 0, fx: 0 };
  for (const t of fresh) counts[t.type]++;
  return { add: fresh, removeIds, near, manualIds, duplicates, counts, span };
}

// Shares per stock in `txns` on `asOf`, compared with IBKR's own position list from the same statement.
export function checkPositions(txns, positions) {
  if (!positions) return null;
  const app = {};
  for (const t of txns) {
    const ty = t.type || 'buy';
    if ((ty !== 'buy' && ty !== 'sell') || t.date > positions.asOf) continue;
    app[t.ticker] = (app[t.ticker] || 0) + (ty === 'buy' ? t.shares : -t.shares);
  }
  const diffs = [];
  const tickers = new Set([...Object.keys(app), ...Object.keys(positions.shares)]);
  let count = 0;
  for (const tk of tickers) {
    const a = +(app[tk] || 0).toFixed(6), b = +(positions.shares[tk] || 0).toFixed(6);
    if (a === 0 && b === 0) continue;
    count++;
    if (Math.abs(a - b) > 1e-6) diffs.push({ ticker: tk, app: a, ibkr: b });
  }
  return { asOf: positions.asOf, ok: diffs.length === 0, diffs, count };
}
