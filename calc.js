// Pure portfolio maths. Every return is measured against cost, never against current value.

export const ret = (cost, value) => (cost > 0 ? (value - cost) / cost : 0);

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// One lot (one buy). q = {price, prevClose} in USD, fxNow = ILS per USD today.
export function lotMetrics(lot, q, fxNow, today = todayISO()) {
  const costUsd = lot.shares * lot.priceUsd + (lot.feesUsd || 0);
  const price = q && q.price > 0 ? q.price : null;
  const valueUsd = price == null ? null : lot.shares * price;
  const r0 = lot.fxAtBuy;
  const r = fxNow;
  const costIls = costUsd * r0;
  const has = valueUsd != null && r > 0;
  const valueIls = has ? valueUsd * r : null;
  let dayUsd = 0;
  if (price != null) {
    if (lot.date >= today) dayUsd = valueUsd - costUsd; // bought today: change since buy
    else if (q.prevClose > 0) dayUsd = lot.shares * (price - q.prevClose);
  }
  return {
    costUsd,
    valueUsd,
    plUsd: valueUsd == null ? null : valueUsd - costUsd,
    retUsd: valueUsd == null ? null : ret(costUsd, valueUsd),
    costIls,
    valueIls,
    plIls: has ? valueIls - costIls : null,
    retIls: has ? ret(costIls, valueIls) : null,
    // ILS P/L split: stock effect at the buy rate + currency effect on today's value
    stockEffectIls: has ? (valueUsd - costUsd) * r0 : null,
    fxEffectIls: has ? valueUsd * (r - r0) : null,
    dayUsd,
    dayIls: r > 0 ? dayUsd * r : 0,
  };
}

const FIELDS = ['costUsd', 'valueUsd', 'costIls', 'valueIls', 'stockEffectIls', 'fxEffectIls', 'dayUsd', 'dayIls'];

function sumUp(items) {
  const s = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let missing = 0;
  for (const m of items) {
    if (m.valueUsd == null) missing++;
    for (const f of FIELDS) s[f] += m[f] || 0;
  }
  // Returns from sums, never averaged percentages. Lots without a price are left out of value-based figures.
  const priced = items.filter((m) => m.valueUsd != null);
  const pc = { usd: priced.reduce((a, m) => a + m.costUsd, 0), ils: priced.reduce((a, m) => a + m.costIls, 0) };
  if (!priced.length) {
    // No prices at all: show "—", not zero
    return { ...s, missing, valueUsd: null, valueIls: null, plUsd: null, plIls: null, retUsd: null, retIls: null,
      stockEffectIls: null, fxEffectIls: null, dayPctUsd: null, dayPctIls: null };
  }
  return {
    ...s,
    missing,
    plUsd: s.valueUsd - pc.usd,
    plIls: s.valueIls - pc.ils,
    retUsd: ret(pc.usd, s.valueUsd),
    retIls: ret(pc.ils, s.valueIls),
    dayPctUsd: s.valueUsd - s.dayUsd > 0 ? s.dayUsd / (s.valueUsd - s.dayUsd) : 0,
    dayPctIls: s.valueIls - s.dayIls > 0 ? s.dayIls / (s.valueIls - s.dayIls) : 0,
  };
}

export const txType = (t) => t.type || 'buy';

// Average ILS paid per USD over all logged conversions up to `date` (inclusive). null if none.
export function avgConversionRate(txns, date = '9999-12-31') {
  let ils = 0, usd = 0;
  for (const t of txns) if (txType(t) === 'fx' && t.date <= date) { ils += t.ils; usd += t.usd; }
  return usd > 0 ? ils / usd : null;
}

const EPS = 1e-9;

// txns: buys / sells / dividends / conversions. quotes: {TICKER: {price, prevClose}}, fxNow: ILS per USD.
// Sells consume buys first-in-first-out (FIFO), as IBKR and the Israeli tax authority do.
export function portfolio(txns, quotes, fxNow, today = todayISO()) {
  const groups = new Map();
  const g = (tk) => { if (!groups.has(tk)) groups.set(tk, { buys: [], sells: [], divs: [] }); return groups.get(tk); };
  for (const t of txns) {
    const ty = txType(t);
    if (ty === 'buy') g(t.ticker).buys.push(t);
    else if (ty === 'sell') g(t.ticker).sells.push(t);
    else if (ty === 'div') g(t.ticker).divs.push(t);
  }
  const holdings = [];
  const allOpen = [];
  const warnings = [];
  const agg = { realizedUsd: 0, realizedIls: 0, divUsd: 0, divIls: 0, divTaxUsd: 0, investedAllUsd: 0, investedAllIls: 0 };

  for (const [ticker, grp] of groups) {
    const events = [...grp.buys.map((t) => [0, t]), ...grp.sells.map((t) => [1, t])]
      .sort((a, b) => a[1].date.localeCompare(b[1].date) || a[0] - b[0]);
    const open = [];
    let realizedUsd = 0, realizedIls = 0, oversold = 0, investedAllUsd = 0, investedAllIls = 0;
    for (const [k, t] of events) {
      if (k === 0) {
        const cost = t.shares * t.priceUsd + (t.feesUsd || 0);
        investedAllUsd += cost; investedAllIls += cost * t.fxAtBuy;
        open.push({ lot: t, remaining: t.shares });
        continue;
      }
      let q = t.shares, costUsd = 0, costIls = 0;
      while (q > EPS && open.length) {
        const o = open[0];
        const take = Math.min(q, o.remaining);
        const per = (o.lot.shares * o.lot.priceUsd + (o.lot.feesUsd || 0)) / o.lot.shares;
        costUsd += take * per; costIls += take * per * o.lot.fxAtBuy;
        o.remaining -= take; q -= take;
        if (o.remaining <= EPS) open.shift();
      }
      if (q > EPS) { oversold += q; warnings.push(`${ticker}: sold ${+q.toFixed(4)} more shares than bought on ${t.date}`); }
      const sold = t.shares - q;
      const net = sold * t.priceUsd - (t.feesUsd || 0);
      realizedUsd += net - costUsd;
      realizedIls += net * t.fx - costIls;
    }
    let divUsd = 0, divIls = 0, divTaxUsd = 0;
    for (const d of grp.divs) { const n = d.grossUsd - (d.taxUsd || 0); divUsd += n; divIls += n * d.fx; divTaxUsd += d.taxUsd || 0; }

    const ms = open.map((o) => {
      const f = o.remaining / o.lot.shares;
      const lot = { ...o.lot, shares: o.remaining, feesUsd: (o.lot.feesUsd || 0) * f };
      return { lot: o.lot, openShares: o.remaining, ...lotMetrics(lot, quotes[ticker], fxNow, today) };
    });
    allOpen.push(...ms);
    const shares = ms.reduce((a, m) => a + m.openShares, 0);
    const closed = shares <= EPS;
    const s = closed ? { ...sumUp([]), valueUsd: 0, valueIls: 0, plUsd: 0, plIls: 0, retUsd: null, retIls: null, stockEffectIls: 0, fxEffectIls: 0 } : sumUp(ms);
    const q = quotes[ticker];
    const totalPlUsd = s.plUsd == null ? null : s.plUsd + realizedUsd + divUsd;
    const totalPlIls = s.plIls == null ? null : s.plIls + realizedIls + divIls;
    holdings.push({
      ticker, shares, closed, oversold,
      avgCostUsd: shares > EPS ? s.costUsd / shares : 0,
      price: q && q.price > 0 ? q.price : null,
      dayPct: q && q.prevClose > 0 && q.price > 0 ? q.price / q.prevClose - 1 : null,
      lots: ms.sort((a, b) => b.lot.date.localeCompare(a.lot.date)),
      buys: grp.buys, sells: grp.sells, divs: grp.divs,
      ...s,
      realizedUsd, realizedIls, divUsd, divIls, divTaxUsd, investedAllUsd, investedAllIls,
      totalPlUsd, totalPlIls,
      totalRetUsd: totalPlUsd == null ? null : ret(investedAllUsd, investedAllUsd + totalPlUsd),
      totalRetIls: totalPlIls == null ? null : ret(investedAllIls, investedAllIls + totalPlIls),
    });
    for (const k of Object.keys(agg)) agg[k] += { realizedUsd, realizedIls, divUsd, divIls, divTaxUsd, investedAllUsd, investedAllIls }[k];
  }

  const total = { ...sumUp(allOpen), ...agg, warnings };
  if (!allOpen.length) Object.assign(total, { valueUsd: 0, valueIls: 0, plUsd: 0, plIls: 0, stockEffectIls: 0, fxEffectIls: 0 });
  total.totalPlUsd = total.plUsd == null ? null : total.plUsd + agg.realizedUsd + agg.divUsd;
  total.totalPlIls = total.plIls == null ? null : total.plIls + agg.realizedIls + agg.divIls;
  total.totalRetUsd = total.totalPlUsd == null ? null : ret(agg.investedAllUsd, agg.investedAllUsd + total.totalPlUsd);
  total.totalRetIls = total.totalPlIls == null ? null : ret(agg.investedAllIls, agg.investedAllIls + total.totalPlIls);
  for (const h of holdings) {
    h.weight = total.valueIls > 0 && h.valueIls ? h.valueIls / total.valueIls : 0;
    const a = annualised([...h.buys, ...h.sells, ...h.divs], h.valueUsd, h.valueIls, today);
    h.annUsd = a.usd; h.annIls = a.ils; h.annShort = a.short;
  }
  const allStock = txns.filter((t) => txType(t) !== 'fx');
  const a = annualised(allStock, total.missing ? null : total.valueUsd, total.missing ? null : total.valueIls, today);
  total.annUsd = a.usd; total.annIls = a.ils; total.annShort = a.short;
  return { holdings, total };
}

// Is the US market open now (approx, ignores holidays)?
export function usMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  return mins >= 570 && mins < 960;
}

export function isStale(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return true;
  const age = now - fetchedAt;
  return usMarketOpen(new Date(now)) ? age > 15 * 60e3 : age > 4 * 24 * 3600e3;
}

// ---------- exact shekel cost of buys from your own conversions (first in, first out) ----------
// Every conversion adds dollars to a pool at its rate; dividends and sale proceeds add dollars at the
// official rate of their date. Each buy spends the oldest dollars first. Dollars converted on the same
// day as a buy count as available to it (IBKR's automatic conversions settle the buy they belong to).
// If the pool runs dry, the missing part uses the official rate of the buy date.
export function fifoBuyRates(txns, official) {
  const ev = [];
  for (const t of txns) {
    const ty = txType(t);
    const k = ty === 'fx' || ty === 'div' ? 0 : ty === 'buy' ? 1 : 2;
    ev.push({ t, ty, k, key: `${t.date}|${k}|${t.time || ''}` });
  }
  ev.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const pool = [];
  const rates = new Map();
  const take = (usd) => { // remove usd from the pool, return ILS cost of what was taken and the shortfall
    let ils = 0;
    while (usd > EPS && pool.length) {
      const p = pool[0];
      const n = Math.min(usd, p.usd);
      ils += n * p.rate; p.usd -= n; usd -= n;
      if (p.usd <= EPS) pool.shift();
    }
    return { ils, short: Math.max(0, usd) };
  };
  for (const { t, ty } of ev) {
    if (ty === 'fx') { if (t.usd > 0) pool.push({ usd: t.usd, rate: t.ils / t.usd }); else take(-t.usd); }
    else if (ty === 'div') { const n = t.grossUsd - (t.taxUsd || 0); if (n > 0) pool.push({ usd: n, rate: t.fx > 0 ? t.fx : official(t.date) }); }
    else if (ty === 'sell') { const n = t.shares * t.priceUsd - (t.feesUsd || 0); if (n > 0) pool.push({ usd: n, rate: t.fx > 0 ? t.fx : official(t.date) }); }
    else {
      const cost = t.shares * t.priceUsd + (t.feesUsd || 0);
      const { ils, short } = take(cost);
      const off = short > EPS ? official(t.date) : 0;
      rates.set(t.id, { rate: (ils + short * (off || 0)) / cost, fromPool: cost - short, short, ok: !(short > EPS && !off) });
    }
  }
  return rates;
}

// ---------- annualised (money-weighted) return ----------
// flows: [{date, amount}] — money in is negative, money out (and today's value) positive.
export function xirr(flows) {
  if (flows.length < 2 || !flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;
  const t0 = Date.parse(flows[0].date);
  const ys = flows.map((f) => (Date.parse(f.date) - t0) / (365.25 * 864e5));
  const npv = (r) => flows.reduce((a, f, i) => a + f.amount / Math.pow(1 + r, ys[i]), 0);
  let lo = -0.9999, hi = 100, flo = npv(lo), fhi = npv(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-9) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// Annualised return for a set of transactions plus today's value, in USD and ILS.
// Returns null figures when the money has been invested for less than a year (annualising would exaggerate).
export function annualised(txns, valueUsd, valueIls, today = todayISO()) {
  const fu = [], fi = [];
  for (const t of txns) {
    const ty = txType(t);
    if (ty === 'buy') { const c = t.shares * t.priceUsd + (t.feesUsd || 0); fu.push({ date: t.date, amount: -c }); fi.push({ date: t.date, amount: -c * t.fxAtBuy }); }
    else if (ty === 'sell') { const n = t.shares * t.priceUsd - (t.feesUsd || 0); fu.push({ date: t.date, amount: n }); fi.push({ date: t.date, amount: n * t.fx }); }
    else if (ty === 'div') { const n = t.grossUsd - (t.taxUsd || 0); fu.push({ date: t.date, amount: n }); fi.push({ date: t.date, amount: n * t.fx }); }
  }
  if (!fu.length) return { usd: null, ils: null, short: false };
  fu.sort((a, b) => a.date.localeCompare(b.date)); fi.sort((a, b) => a.date.localeCompare(b.date));
  const days = (Date.parse(today) - Date.parse(fu[0].date)) / 864e5;
  if (days < 365) return { usd: null, ils: null, short: true };
  if (valueUsd != null) fu.push({ date: today, amount: valueUsd });
  if (valueIls != null) fi.push({ date: today, amount: valueIls });
  return { usd: valueUsd == null ? null : xirr(fu), ils: valueIls == null ? null : xirr(fi), short: false };
}
