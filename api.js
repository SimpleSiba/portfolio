// One adapter per source: fetch + normalise only.

async function getText(url, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

async function getJSON(url, ms = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 429) throw new Error('Rate limit reached — try again in a minute');
    if (r.status === 401 || r.status === 403) throw new Error('API key rejected');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    if (e instanceof TypeError) throw new Error('Network error (offline?)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Finnhub /quote → {price, prevClose, changePct, time}
export async function finnhubQuote(symbol, key) {
  const j = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`);
  if (j.error) throw new Error(j.error);
  if (!j.c) throw new Error(`No price for ${symbol}`);
  return { price: j.c, prevClose: j.pc || null, changePct: j.dp ?? null, time: j.t ? j.t * 1000 : null, source: 'finnhub' };
}

// Twelve Data /quote → same shape (fallback source)
export async function twelveQuote(symbol, key) {
  const j = await getJSON(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`);
  if (j.status === 'error') throw new Error(j.message || 'Twelve Data error');
  const price = Number(j.close);
  if (!price) throw new Error(`No price for ${symbol}`);
  return {
    price,
    prevClose: Number(j.previous_close) || null,
    changePct: j.percent_change != null ? Number(j.percent_change) : null,
    time: j.timestamp ? j.timestamp * 1000 : null,
    name: j.name,
    source: 'twelvedata',
  };
}

export async function quote(symbol, keys) {
  const errs = [];
  if (keys.finnhubKey) {
    try { return await finnhubQuote(symbol, keys.finnhubKey); } catch (e) { errs.push(`Finnhub: ${e.message}`); }
  }
  if (keys.twelveKey) {
    try { return await twelveQuote(symbol, keys.twelveKey); } catch (e) { errs.push(`Twelve Data: ${e.message}`); }
  }
  if (!errs.length) throw new Error('No API key set — add one in Settings');
  throw new Error(errs.join(' · '));
}

// Frankfurter: USD→ILS. date = 'YYYY-MM-DD' or 'latest'. Returns {rate, date}.
export async function fxUsdIls(date = 'latest') {
  const j = await getJSON(`https://api.frankfurter.dev/v1/${date}?base=USD&symbols=ILS`);
  const rate = j?.rates?.ILS;
  if (!rate) throw new Error('No USD/ILS rate');
  return { rate, date: j.date };
}

// Run tasks with at most `n` in flight.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = { ok: true, value: await fn(items[k]) }; } catch (e) { out[k] = { ok: false, error: e }; }
    }
  });
  await Promise.all(workers);
  return out;
}

// Daily USD→ILS rates from `from` (YYYY-MM-DD) to today: {date: rate}, business days only.
export async function fxSeries(from) {
  const j = await getJSON(`https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=ILS`, 20000);
  const out = {};
  for (const [d, r] of Object.entries(j?.rates || {})) if (r?.ILS) out[d] = r.ILS;
  if (!Object.keys(out).length) throw new Error('No USD/ILS history');
  return out;
}

// Rate on `date`, or the last business day before it.
export function rateOn(series, date) {
  let best = null;
  for (const d in series) if (d <= date && (!best || d > best)) best = d;
  return best ? series[best] : null;
}

// ---------- official USD/ILS: Bank of Israel representative rate, with Frankfurter as fallback ----------
const isoMinus = (iso, days) => new Date(Date.parse(iso) - days * 864e5).toISOString().slice(0, 10);
const todayUTC = () => new Date().toISOString().slice(0, 10);
export const rateInfo = { source: null }; // 'boi' | 'ecb'

async function boiSeries(from) {
  const url = `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS?startperiod=${from}&format=csv`;
  const text = await getText(url);
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.replace(/"/g, '').trim().toUpperCase());
  const iT = head.indexOf('TIME_PERIOD'), iV = head.indexOf('OBS_VALUE');
  if (iT < 0 || iV < 0) throw new Error('Unexpected Bank of Israel format');
  const out = {};
  for (const l of lines.slice(1)) {
    const c = l.split(',').map((x) => x.replace(/"/g, '').trim());
    const d = c[iT], v = Number(c[iV]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v > 1 && v < 10) out[d] = v;
  }
  if (!Object.keys(out).length) throw new Error('No Bank of Israel rates');
  return out;
}

let cache = null; // {from, day, series, source}
export async function officialSeries(from) {
  const day = todayUTC();
  if (cache && cache.day === day && cache.from <= from) return cache.series;
  let series, source;
  try { series = await boiSeries(from); source = 'boi'; }
  catch { series = await fxSeries(from); source = 'ecb'; }
  rateInfo.source = source;
  cache = { from, day, series, source };
  return series;
}

// Official rate on a date ('latest' = most recent published). Returns {rate, date, source}.
export async function officialRate(date = 'latest') {
  const d = date === 'latest' || date >= todayUTC() ? todayUTC() : date;
  const series = await officialSeries(isoMinus(d, 10));
  let best = null;
  for (const k in series) if (k <= d && (!best || k > best)) best = k;
  if (!best) throw new Error('No USD/ILS rate for ' + d);
  return { rate: series[best], date: best, source: rateInfo.source };
}
