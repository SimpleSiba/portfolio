// One adapter per source: fetch + normalise only.

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
