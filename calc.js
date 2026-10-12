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

// lots: array, quotes: {TICKER: {price, prevClose}}, fxNow: number
export function portfolio(lots, quotes, fxNow, today = todayISO()) {
  const byTicker = new Map();
  const all = [];
  for (const lot of lots) {
    const m = { lot, ...lotMetrics(lot, quotes[lot.ticker], fxNow, today) };
    all.push(m);
    if (!byTicker.has(lot.ticker)) byTicker.set(lot.ticker, []);
    byTicker.get(lot.ticker).push(m);
  }
  const holdings = [...byTicker.entries()].map(([ticker, ms]) => {
    const shares = ms.reduce((a, m) => a + m.lot.shares, 0);
    const s = sumUp(ms);
    const q = quotes[ticker];
    return {
      ticker,
      shares,
      avgCostUsd: shares > 0 ? s.costUsd / shares : 0,
      price: q && q.price > 0 ? q.price : null,
      dayPct: q && q.prevClose > 0 && q.price > 0 ? q.price / q.prevClose - 1 : null,
      lots: ms.sort((a, b) => b.lot.date.localeCompare(a.lot.date)),
      ...s,
    };
  });
  const total = sumUp(all);
  for (const h of holdings) {
    h.weight = total.valueIls > 0 && h.valueIls ? h.valueIls / total.valueIls : 0;
  }
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
