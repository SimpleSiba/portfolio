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
  for (const h of holdings) h.weight = total.valueIls > 0 && h.valueIls ? h.valueIls / total.valueIls : 0;
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
