// Day-by-day portfolio history from transactions + daily closes + daily USD/ILS (pure functions).

// Value of each series on each trading day (dates from the benchmark's calendar).
// closes: {TICKER: {date: close}}; fx: {date: rate}; bench: {date: close} (SPY); live: {TICKER: price} for today.
export function buildHistory({ txns, closes, fx, bench, today, live = {}, liveFx = null }) {
  const ty = (t) => t.type || 'buy';
  const stock = txns.filter((t) => ty(t) === 'buy' || ty(t) === 'sell').sort((a, b) => a.date.localeCompare(b.date) || (ty(a) === 'buy' ? -1 : 1));
  if (!stock.length) return null;
  const divs = txns.filter((t) => ty(t) === 'div').sort((a, b) => a.date.localeCompare(b.date));
  const first = stock[0].date;
  const days = Object.keys(bench).filter((d) => d >= first && d <= today).sort();
  if (!days.length || days[days.length - 1] < today) days.push(today);
  const last = {}; // carry-forward closes per ticker
  const seed = (tk, d) => { // last known close on/before d
    const s = closes[tk] || {};
    let best = null;
    for (const k in s) if (k <= d && (!best || k > best)) best = k;
    return best ? s[best] : null;
  };
  let fxLast = null, benchLast = null;
  const fxOn = (d) => { if (fx[d]) fxLast = fx[d]; if (fxLast == null) { let b = null; for (const k in fx) if (k <= d && (!b || k > b)) b = k; fxLast = b ? fx[b] : null; } return fxLast; };
  const lots = new Map(); // ticker -> [{rem, per, r0}]
  let bShares = 0, i = 0, j = 0;
  let realU = 0, realI = 0, divU = 0, divI = 0;              // cumulative realised profit and dividends
  let idxU = 100, idxI = 100, prevU = 0, prevI = 0;        // time-weighted "growth of 100"
  let b0 = null, r0b = null;                               // benchmark start (price, fx)
  const out = { dates: [], valueUsd: [], valueIls: [], investedUsd: [], investedIls: [], benchUsd: [], benchIls: [],
    stockIls: [], fxIls: [], profitUsd: [], profitIls: [], twrUsd: [], twrIls: [], benchIdxUsd: [], benchIdxIls: [], missing: new Set() };
  for (const d of days) {
    const isToday = d === today;
    if (bench[d]) benchLast = bench[d];
    const bPrice = isToday && live.SPY ? live.SPY : benchLast;
    const r = isToday && liveFx ? liveFx : fxOn(d);
    let inU = 0, outU = 0; // money in (buys) and out (sales, dividends) today, USD
    while (i < stock.length && stock[i].date <= d) {
      const t = stock[i++];
      const cost = t.shares * t.priceUsd + (t.feesUsd || 0);
      if (ty(t) === 'buy') {
        if (!lots.has(t.ticker)) lots.set(t.ticker, []);
        lots.get(t.ticker).push({ rem: t.shares, per: cost / t.shares, r0: t.fxAtBuy });
        if (bPrice) bShares += cost / bPrice;
        inU += cost;
      } else {
        let q = t.shares, cU = 0, cI = 0;
        const ls = lots.get(t.ticker) || [];
        while (q > 1e-9 && ls.length) { const n = Math.min(q, ls[0].rem); cU += n * ls[0].per; cI += n * ls[0].per * ls[0].r0; ls[0].rem -= n; q -= n; if (ls[0].rem <= 1e-9) ls.shift(); }
        const net = t.shares * t.priceUsd - (t.feesUsd || 0);
        realU += net - cU; realI += net * (t.fx || r || 0) - cI;
        if (bPrice) bShares = Math.max(0, bShares - net / bPrice);
        outU += net;
      }
    }
    while (j < divs.length && divs[j].date <= d) {
      const t = divs[j++]; const n = t.grossUsd - (t.taxUsd || 0);
      divU += n; divI += n * (t.fx || r || 0); outU += n;
    }
    let vU = 0, iU = 0, iI = 0, sE = 0, fE = 0;
    for (const [tk, ls] of lots) {
      if (!ls.length) continue;
      if (closes[tk]?.[d]) last[tk] = closes[tk][d];
      else if (last[tk] == null) last[tk] = seed(tk, d);
      const p = isToday && live[tk] ? live[tk] : last[tk];
      for (const l of ls) {
        iU += l.rem * l.per; iI += l.rem * l.per * l.r0;
        if (p == null) { out.missing.add(tk); continue; }
        vU += l.rem * p; sE += (l.rem * p - l.rem * l.per) * l.r0; fE += l.rem * p * ((r || l.r0) - l.r0);
      }
    }
    const vI = r ? vU * r : null;
    // Time-weighted: money added today counts from the start of the day, money taken out counts as part of today's result.
    if (prevU + inU > 0) idxU *= (vU + outU) / (prevU + inU);
    if (r && prevI + inU * r > 0) idxI *= (vI + outU * r) / (prevI + inU * r);
    prevU = vU; prevI = vI || 0;
    if (b0 == null && bPrice) { b0 = bPrice; r0b = r; }
    out.dates.push(d);
    out.valueUsd.push(vU); out.valueIls.push(vI);
    out.investedUsd.push(iU); out.investedIls.push(iI);
    out.benchUsd.push(bPrice ? bShares * bPrice : null); out.benchIls.push(bPrice && r ? bShares * bPrice * r : null);
    out.stockIls.push(sE); out.fxIls.push(r ? fE : null);
    out.profitUsd.push(vU - iU + realU + divU); out.profitIls.push(vI == null ? null : vI - iI + realI + divI);
    out.twrUsd.push(idxU); out.twrIls.push(r ? idxI : null);
    out.benchIdxUsd.push(bPrice && b0 ? (100 * bPrice) / b0 : null);
    out.benchIdxIls.push(bPrice && b0 && r && r0b ? (100 * bPrice * r) / (b0 * r0b) : null);
  }
  out.missing = [...out.missing];
  return out;
}

// Rebase an index series so it equals 100 at position i0.
export const rebase = (arr, i0) => { const b = arr[i0]; return arr.slice(i0).map((v) => (v == null || !b ? null : (100 * v) / b)); };

// Change of a price over the last `days` calendar days (live price vs close on/before that date).
export function changeOver(closes, now, days, today) {
  if (!closes || !(now > 0)) return null;
  const target = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
  let best = null;
  for (const k in closes) if (k <= target && (!best || k > best)) best = k;
  if (!best) return null;
  return now / closes[best] - 1;
}

// Index of the first date in a range ('1M','3M','6M','1Y','ALL').
export function rangeStart(dates, range, today) {
  const days = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366 }[range];
  if (!days) return 0;
  const from = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
  const i = dates.findIndex((d) => d >= from);
  return i < 0 ? 0 : i;
}
