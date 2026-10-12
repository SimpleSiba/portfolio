import { html, render, useState, useEffect, useMemo, useRef } from './preact-htm.mjs';
import * as db from './db.js';
import * as api from './api.js';
import { portfolio, isStale, todayISO } from './calc.js';

const VERSION = '1.1.0';
const DEFAULT_SETTINGS = { finnhubKey: '', twelveKey: '', ccy: 'ILS' };
const MIN_REFRESH_MS = 60e3;

// ---------- formatting ----------
const MINUS = '−';
const nf = {};
function fmtMoney(v, ccy, dec = 0) {
  if (v == null || !isFinite(v)) return '—';
  const k = ccy + dec;
  nf[k] ||= new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, minimumFractionDigits: dec, maximumFractionDigits: dec });
  return nf[k].format(Math.abs(v)).replace(/^/, v < 0 ? MINUS : '');
}
const fmtSigned = (v, ccy, dec = 0) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + fmtMoney(v, ccy, dec));
const fmtPct = (p, dec = 2) => (p == null || !isFinite(p) ? '—' : (p > 0 ? '+' : p < 0 ? MINUS : '') + Math.abs(p * 100).toFixed(dec) + '%');
const fmtNum = (v, dec = 4) => (v == null ? '—' : Number(v.toFixed(dec)).toLocaleString('en-US', { maximumFractionDigits: dec }));
const tone = (v) => (v == null || Math.abs(v) < 1e-9 ? '' : v > 0 ? 'gain' : 'loss');
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString('en-GB');
}

// ---------- routing (hash, so Android back works) ----------
function parseRoute(hash = location.hash) {
  const p = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p[0] === 'holdings') return { tab: 'holdings' };
  if (p[0] === 'settings') return { tab: 'settings' };
  if (p[0] === 't' && p[1]) return { tab: 'holdings', ticker: p[1] };
  if (p[0] === 'lot' && p[1] === 'new') return { tab: 'holdings', form: { isNew: true, ticker: p[2] || '' } };
  if (p[0] === 'lot' && p[1]) return { tab: 'holdings', form: { id: p[1] } };
  return { tab: 'home' };
}
let prevHash = null;
const go = (hash) => { prevHash = location.hash; location.hash = hash; };
// Leave the form: go back if the screen we came from is the target, else replace the form entry.
function leaveTo(hash) {
  if (prevHash === hash) { prevHash = null; history.back(); return; }
  history.replaceState(history.state, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
const goTab = (tab) => { history.replaceState(history.state, '', '#' + tab); window.dispatchEvent(new HashChangeEvent('hashchange')); };
const back = (fallback) => { if (history.length > 1 && history.state !== 'root') history.back(); else goTab(fallback); };

// ---------- icons ----------
const Icon = ({ d, size = 22 }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${d}/></svg>`;
const I = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  refresh: 'M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  chev: 'M9 18l6-6-6-6',
};

// ---------- small components ----------
const Pill = ({ value, pct, dec = 2 }) => html`<span class=${'pill ' + tone(value)}>${fmtPct(value, dec)}</span>`;

function Toast({ toast, onClose }) {
  useEffect(() => { if (toast) { const t = setTimeout(onClose, toast.ms || 4000); return () => clearTimeout(t); } }, [toast]);
  if (!toast) return null;
  return html`<div class=${'toast ' + (toast.kind || '')} role="status" onClick=${onClose}>${toast.text}</div>`;
}

function Segmented({ value, options, onChange, label }) {
  return html`<div class="seg" role="group" aria-label=${label}>
    ${options.map(([v, t]) => html`<button class=${value === v ? 'on' : ''} aria-pressed=${value === v} onClick=${() => onChange(v)}>${t}</button>`)}
  </div>`;
}

function StatusLine({ quotes, fx, tickers, loading, noKey }) {
  const times = tickers.map((t) => quotes[t]?.fetchedAt || 0);
  const oldest = times.length ? Math.min(...times) : 0;
  const stale = isStale(oldest);
  return html`<div class="status">
    <span class=${'dot ' + (loading ? 'busy' : stale ? 'stale' : 'fresh')}></span>
    ${loading ? 'Updating…' : noKey ? html`No API key yet · <a href="#settings">add one in Settings</a> for live prices` : `Prices ${fmtAgo(oldest)}`}
    ${fx?.rate ? html` · USD/ILS ${fx.rate.toFixed(4)}` : ''}
  </div>`;
}

// ---------- screens ----------
function Welcome({ state, onImport }) {
  const fileRef = useRef();
  return html`<section class="welcome">
    <div class="hero"><div class="big">Welcome</div>
      <p class="muted">Track your stocks with live prices and correct returns. Everything you enter stays on this phone only.</p></div>
    <div class="card steps">
      <div class=${'step ' + (state.noKey ? '' : 'done')}>
        <span class="n">${state.noKey ? '1' : '✓'}</span>
        <div><b>Add a free price key</b><p class="muted small">Sign up at finnhub.io (free), copy your API key, paste it in Settings.</p>
          ${state.noKey && html`<button class="btn small" onClick=${() => goTab('settings')}>Open Settings</button>`}</div>
      </div>
      <div class="step">
        <span class="n">2</span>
        <div><b>Add your investments</b><p class="muted small">Enter each buy: ticker, date, shares, price in USD.</p>
          <div class="btns"><button class="btn small primary" onClick=${() => go('#lot/new')}>Add a buy</button>
          <button class="btn small" onClick=${() => fileRef.current.click()}>Import backup file</button></div>
          <input type="file" accept="application/json,.json" ref=${fileRef} hidden onChange=${(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onImport(f); }}/></div>
      </div>
    </div>
  </section>`;
}

function Home({ pf, ccy, setCcy, state, onRefresh, onExport, onImport }) {
  if (!state.lots.length) return html`<${Welcome} state=${state} onImport=${onImport}/>`;
  const { total, holdings } = pf;
  const C = ccy === 'ILS' ? 'Ils' : 'Usd';
  const ranked = holdings.filter((h) => h['ret' + C] != null).sort((a, b) => b['ret' + C] - a['ret' + C]);
  const gainers = ranked.filter((h) => h['ret' + C] > 0).slice(0, 3);
  const losers = ranked.filter((h) => h['ret' + C] < 0).slice(-3).reverse();
  const needBackup = !state.meta.lastExport || Date.now() - state.meta.lastExport > 30 * 864e5;
  const Row = (h) => html`<button class="row" onClick=${() => go('#t/' + h.ticker)}>
      <span class="tk">${h.ticker}</span>
      <span class="num muted">${fmtSigned(h['pl' + C], ccy)}</span>
      <${Pill} value=${h['ret' + C]}/>
    </button>`;
  return html`<section>
    <div class="hero">
      <div class="label">Total value</div>
      <div class="big num">${fmtMoney(total['value' + C], ccy)}</div>
      <div class="sub">
        <span class=${'num ' + tone(total['pl' + C])}>${fmtSigned(total['pl' + C], ccy)} (${fmtPct(total['ret' + C])})</span>
        <span class="muted"> all time</span>
      </div>
      <div class="sub">
        ${holdings.some((h) => h.dayPct != null)
          ? html`<span class=${'num ' + tone(total['day' + C])}>${fmtSigned(total['day' + C], ccy)} (${fmtPct(total['dayPct' + C])})</span><span class="muted"> today</span>`
          : html`<span class="muted">Today’s change shows after the first live update</span>`}
      </div>
      <div class="hero-foot">
        <span class="muted">Invested ${fmtMoney(total['cost' + C], ccy)}</span>
        <${Segmented} label="Currency" value=${ccy} onChange=${setCcy} options=${[['ILS', '₪'], ['USD', '$']]}/>
      </div>
    </div>
    <${StatusLine} quotes=${state.quotes} fx=${state.fx} tickers=${holdings.map((h) => h.ticker)} loading=${state.loading} noKey=${state.noKey}/>
    ${total.missing > 0 && html`<div class="banner warn">${total.missing} lot(s) have no price yet and are left out of the totals.</div>`}
    ${ccy === 'ILS' && total.stockEffectIls != null && html`<div class="card split">
      <div><div class="label">Stock moves</div><div class=${'num ' + tone(total.stockEffectIls)}>${fmtSigned(total.stockEffectIls, 'ILS')}</div></div>
      <div><div class="label">Currency (USD/ILS)</div><div class=${'num ' + tone(total.fxEffectIls)}>${fmtSigned(total.fxEffectIls, 'ILS')}</div></div>
    </div>`}
    ${gainers.length > 0 && html`<h2>Top gainers</h2><div class="card list">${gainers.map(Row)}</div>`}
    ${losers.length > 0 && html`<h2>Top losers</h2><div class="card list">${losers.map(Row)}</div>`}
    ${needBackup && html`<div class="banner">
      <span>${state.meta.lastExport ? 'Last backup over 30 days ago.' : 'No backup yet.'} Holdings live only on this phone.</span>
      <button class="btn small" onClick=${onExport}>Back up</button>
    </div>`}
  </section>`;
}

const SORTS = { value: 'Value', pl: 'P/L', ret: 'Return', day: 'Today' };
function Holdings({ pf, ccy, sort, setSort }) {
  if (!pf.holdings.length) return html`<section><div class="card placeholder"><p>No investments yet.</p><button class="btn primary" onClick=${() => go('#lot/new')}>Add your first buy</button></div></section>`;
  const C = ccy === 'ILS' ? 'Ils' : 'Usd';
  const key = { value: (h) => h['value' + C] ?? -Infinity, pl: (h) => h['pl' + C] ?? -Infinity, ret: (h) => h['ret' + C] ?? -Infinity, day: (h) => h.dayPct ?? -Infinity }[sort];
  const rows = [...pf.holdings].sort((a, b) => key(b) - key(a));
  return html`<section>
    <div class="chips" role="group" aria-label="Sort by">
      ${Object.entries(SORTS).map(([k, t]) => html`<button class=${'chip ' + (sort === k ? 'on' : '')} aria-pressed=${sort === k} onClick=${() => setSort(k)}>${t}</button>`)}
    </div>
    <div class="card list">
      ${rows.map((h) => html`<button class="hrow" onClick=${() => go('#t/' + h.ticker)}>
        <div class="l">
          <div class="tk">${h.ticker}</div>
          <div class="muted small">${fmtNum(h.shares)} sh · avg ${fmtMoney(h.avgCostUsd, 'USD', 2)}</div>
          <div class="weight"><span style=${`width:${(h.weight * 100).toFixed(1)}%`}></span></div>
        </div>
        <div class="r">
          <div class="num">${fmtMoney(h['value' + C], ccy)}</div>
          <div class="small"><span class=${'num ' + tone(h['pl' + C])}>${fmtSigned(h['pl' + C], ccy)}</span> <${Pill} value=${h['ret' + C]} dec=${1}/></div>
          <div class="small muted">today <span class=${tone(h.dayPct)}>${fmtPct(h.dayPct)}</span></div>
        </div>
      </button>`)}
    </div>
    <p class="muted small center">${pf.holdings.length} holdings · ${pf.holdings.reduce((a, h) => a + h.lots.length, 0)} buys</p>
  </section>`;
}

function Detail({ ticker, pf, ccy, quotes }) {
  const h = pf.holdings.find((x) => x.ticker === ticker);
  const C = ccy === 'ILS' ? 'Ils' : 'Usd';
  if (!h) return html`<section><p class="muted">No holding ${ticker}.</p><button class="btn" onClick=${() => go('#lot/new/' + ticker)}>Add a buy</button></section>`;
  const q = quotes[ticker] || {};
  const stats = [
    ['Shares', fmtNum(h.shares)],
    ['Avg cost', fmtMoney(h.avgCostUsd, 'USD', 2)],
    ['Invested', fmtMoney(h['cost' + C], ccy)],
    ['Value', fmtMoney(h['value' + C], ccy)],
    ['P/L', html`<span class=${tone(h['pl' + C])}>${fmtSigned(h['pl' + C], ccy)}</span>`],
    ['Return', html`<span class=${tone(h['ret' + C])}>${fmtPct(h['ret' + C])}</span>`],
    ['Weight', fmtPct(h.weight, 1).replace('+', '')],
    ['Today', html`<span class=${tone(h['day' + C])}>${fmtSigned(h['day' + C], ccy)}</span>`],
  ];
  if (ccy === 'ILS') stats.push(['Stock effect', html`<span class=${tone(h.stockEffectIls)}>${fmtSigned(h.stockEffectIls, 'ILS')}</span>`], ['Currency effect', html`<span class=${tone(h.fxEffectIls)}>${fmtSigned(h.fxEffectIls, 'ILS')}</span>`]);
  return html`<section>
    <div class="hero compact">
      <div class="label">${q.name || ticker} · last price</div>
      <div class="big num">${fmtMoney(h.price, 'USD', 2)}</div>
      <div class="sub"><span class=${tone(h.dayPct)}>${fmtPct(h.dayPct)} today</span><span class="muted"> · ${fmtAgo(q.fetchedAt)}</span></div>
    </div>
    <div class="card grid">${stats.map(([k, v]) => html`<div><div class="label">${k}</div><div class="num">${v}</div></div>`)}</div>
    <div class="card placeholder muted small">Price chart since first buy — coming in v2</div>
    <h2>Buys</h2>
    <div class="card list">
      ${h.lots.map((m) => html`<button class="hrow" onClick=${() => go('#lot/' + m.lot.id)}>
        <div class="l">
          <div>${fmtDate(m.lot.date)}</div>
          <div class="muted small">${fmtNum(m.lot.shares)} × ${fmtMoney(m.lot.priceUsd, 'USD', 2)} · ₪/$ ${m.lot.fxAtBuy.toFixed(4)}</div>
        </div>
        <div class="r">
          <div class="num">${fmtMoney(m['cost' + C], ccy)}</div>
          <div class="small"><${Pill} value=${m['ret' + C]} dec=${1}/></div>
        </div>
        <span class="muted"><${Icon} d=${I.chev} size=${18}/></span>
      </button>`)}
    </div>
    <button class="btn wide" onClick=${() => go('#lot/new/' + ticker)}>Add a buy of ${ticker}</button>
  </section>`;
}

function LotForm({ route, lots, settings, onSave, onDelete, toast }) {
  const existing = route.form.id ? lots.find((l) => l.id === route.form.id) : null;
  const [f, setF] = useState(() => existing
    ? { ...existing, shares: String(existing.shares), priceUsd: String(existing.priceUsd), feesUsd: String(existing.feesUsd || 0), fxAtBuy: String(existing.fxAtBuy) }
    : { ticker: route.form.ticker || '', date: todayISO(), shares: '', priceUsd: '', feesUsd: '0', fxAtBuy: '', note: '' });
  const [fxEdited, setFxEdited] = useState(!!existing);
  const [fxBusy, setFxBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const set = (k) => (e) => setF((o) => ({ ...o, [k]: e.target.value }));

  useEffect(() => {
    if (fxEdited || !f.date) return;
    let live = true;
    setFxBusy(true);
    api.fxUsdIls(f.date >= todayISO() ? 'latest' : f.date)
      .then((r) => live && setF((o) => ({ ...o, fxAtBuy: String(r.rate) })))
      .catch(() => {})
      .finally(() => live && setFxBusy(false));
    return () => { live = false; };
  }, [f.date, fxEdited]);

  async function checkTicker() {
    const t = f.ticker.trim().toUpperCase();
    if (!t || (!settings.finnhubKey && !settings.twelveKey)) return;
    setCheck({ busy: true });
    try { const q = await api.quote(t, settings); setCheck({ ok: true, text: `Found · ${fmtMoney(q.price, 'USD', 2)}` }); }
    catch (e) { setCheck({ ok: false, text: e.message }); }
  }

  const num = (s) => Number(String(s).replace(',', '.'));
  const errors = {};
  if (!/^[A-Z0-9.\-]{1,10}$/.test(f.ticker.trim().toUpperCase())) errors.ticker = 'Ticker like AAPL';
  if (!f.date || f.date > todayISO()) errors.date = 'Date can’t be in the future';
  if (!(num(f.shares) > 0)) errors.shares = 'More than 0';
  if (!(num(f.priceUsd) > 0)) errors.priceUsd = 'More than 0';
  if (!(num(f.feesUsd) >= 0)) errors.feesUsd = '0 or more';
  if (!(num(f.fxAtBuy) > 1 && num(f.fxAtBuy) < 10)) errors.fxAtBuy = 'ILS per USD, e.g. 3.0573';
  const [touched, setTouched] = useState(false);
  const ok = Object.keys(errors).length === 0;
  const cost = num(f.shares) * num(f.priceUsd) + (num(f.feesUsd) || 0);

  function save(e) {
    e.preventDefault();
    setTouched(true);
    if (!ok) return;
    onSave({
      id: existing?.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      ticker: f.ticker.trim().toUpperCase(), date: f.date, shares: num(f.shares), priceUsd: num(f.priceUsd),
      feesUsd: num(f.feesUsd) || 0, fxAtBuy: num(f.fxAtBuy), note: f.note || '',
    });
  }
  const Err = ({ k }) => touched && errors[k] ? html`<span class="err">${errors[k]}</span>` : null;
  return html`<form class="form" onSubmit=${save} novalidate>
    <label>Ticker <${Err} k="ticker"/>
      <input value=${f.ticker} onInput=${set('ticker')} onBlur=${checkTicker} autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="AAPL" required/>
      ${check && html`<span class=${'hint ' + (check.busy ? '' : check.ok ? 'gain' : 'loss')}>${check.busy ? 'Checking…' : check.text}</span>`}
    </label>
    <label>Buy date <${Err} k="date"/><input type="date" value=${f.date} max=${todayISO()} onInput=${(e) => { setFxEdited(false); set('date')(e); }}/></label>
    <div class="two">
      <label>Shares <${Err} k="shares"/><input inputmode="decimal" value=${f.shares} onInput=${set('shares')} placeholder="10"/></label>
      <label>Price per share (USD) <${Err} k="priceUsd"/><input inputmode="decimal" value=${f.priceUsd} onInput=${set('priceUsd')} placeholder="310.25"/></label>
    </div>
    <div class="two">
      <label>Fees (USD) <${Err} k="feesUsd"/><input inputmode="decimal" value=${f.feesUsd} onInput=${set('feesUsd')}/></label>
      <label>USD/ILS at buy <${Err} k="fxAtBuy"/>
        <input inputmode="decimal" value=${f.fxAtBuy} onInput=${(e) => { setFxEdited(true); set('fxAtBuy')(e); }} placeholder=${fxBusy ? 'loading…' : '3.0573'}/>
        <span class="hint muted">${fxEdited ? 'Your rate' : fxBusy ? 'Fetching rate…' : 'Official rate for that date — edit to your broker’s'}</span>
      </label>
    </div>
    <label>Note<input value=${f.note} onInput=${set('note')} placeholder="optional"/></label>
    <div class="card summary">
      <span class="muted">Total cost</span>
      <span class="num">${isFinite(cost) && cost > 0 ? `${fmtMoney(cost, 'USD', 2)} · ${num(f.fxAtBuy) > 0 ? fmtMoney(cost * num(f.fxAtBuy), 'ILS', 2) : ''}` : '—'}</span>
    </div>
    <button class="btn wide primary" type="submit">${existing ? 'Save changes' : 'Add buy'}</button>
    ${existing && html`<button type="button" class=${'btn wide ' + (confirmDel ? 'danger' : 'ghost')} onClick=${() => confirmDel ? onDelete(existing.id) : setConfirmDel(true)}>
      ${confirmDel ? 'Tap again to delete this buy' : 'Delete this buy'}</button>`}
  </form>`;
}

function Settings({ state, saveSettings, onExport, onImport, onRefresh, onDeleteAll, toast }) {
  const s = state.settings;
  const [keys, setKeys] = useState({ finnhubKey: s.finnhubKey, twelveKey: s.twelveKey });
  const [show, setShow] = useState(false);
  const [test, setTest] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const fileRef = useRef();
  const dirty = keys.finnhubKey !== s.finnhubKey || keys.twelveKey !== s.twelveKey;

  async function runTest() {
    setTest({ busy: true });
    const res = {};
    const t = async (name, fn) => { try { res[name] = { ok: true, text: await fn() }; } catch (e) { res[name] = { ok: false, text: e.message }; } };
    await Promise.all([
      keys.finnhubKey ? t('Finnhub', async () => `SPY ${fmtMoney((await api.finnhubQuote('SPY', keys.finnhubKey.trim())).price, 'USD', 2)}`) : (res.Finnhub = { ok: false, text: 'No key' }),
      keys.twelveKey ? t('Twelve Data', async () => `SPY ${fmtMoney((await api.twelveQuote('SPY', keys.twelveKey.trim())).price, 'USD', 2)}`) : (res['Twelve Data'] = { ok: false, text: 'No key' }),
      t('Frankfurter', async () => { const r = await api.fxUsdIls(); return `USD/ILS ${r.rate} (${r.date})`; }),
    ]);
    setTest(res);
  }

  return html`<section class="settings">
    <h2>API keys</h2>
    <div class="card form">
      <label>Finnhub key <span class="hint muted">live prices · finnhub.io</span>
        <input type=${show ? 'text' : 'password'} value=${keys.finnhubKey} onInput=${(e) => setKeys({ ...keys, finnhubKey: e.target.value })} autocomplete="off" spellcheck="false"/></label>
      <label>Twelve Data key <span class="hint muted">history + backup prices · twelvedata.com</span>
        <input type=${show ? 'text' : 'password'} value=${keys.twelveKey} onInput=${(e) => setKeys({ ...keys, twelveKey: e.target.value })} autocomplete="off" spellcheck="false"/></label>
      <label class="check"><input type="checkbox" checked=${show} onChange=${(e) => setShow(e.target.checked)}/> Show keys</label>
      <div class="two">
        <button class="btn" type="button" onClick=${runTest}>Test keys</button>
        <button class="btn primary" type="button" disabled=${!dirty} onClick=${async () => { await saveSettings({ finnhubKey: keys.finnhubKey.trim(), twelveKey: keys.twelveKey.trim() }); toast('Keys saved'); onRefresh(true); }}>Save keys</button>
      </div>
      ${test && (test.busy ? html`<p class="muted small">Testing…</p>` : html`<ul class="tests">${Object.entries(test).map(([k, r]) => html`<li><span class=${r.ok ? 'gain' : 'loss'}>${r.ok ? '✓' : '✗'}</span> ${k}: ${r.text}</li>`)}</ul>`)}
      <p class="muted small">Each person uses their own free keys. Keys stay on this phone and are not included in backups.</p>
    </div>

    <h2>Display</h2>
    <div class="card row-between">
      <span>Main currency</span>
      <${Segmented} label="Main currency" value=${s.ccy} onChange=${(v) => saveSettings({ ccy: v })} options=${[['ILS', '₪ ILS'], ['USD', '$ USD']]}/>
    </div>

    <h2>Backup</h2>
    <div class="card form">
      <p class="small muted">Last backup: ${state.meta.lastExport ? new Date(state.meta.lastExport).toLocaleString('en-GB') : 'never'} · storage ${state.persisted ? 'protected' : 'not protected'}</p>
      <div class="two">
        <button class="btn" type="button" onClick=${onExport}>Export JSON</button>
        <button class="btn" type="button" onClick=${() => fileRef.current.click()}>Import JSON</button>
      </div>
      <p class="small muted">Import replaces all buys on this phone with the ones in the file.</p>
      <input type="file" accept="application/json,.json" ref=${fileRef} hidden onChange=${(e) => { const file = e.target.files[0]; e.target.value = ''; if (file) onImport(file); }}/>
    </div>

    <h2>Data</h2>
    <div class="card form">
      <button class="btn" type="button" onClick=${() => onRefresh(true)}>Refresh prices now</button>
      <button class=${'btn ' + (confirmDel ? 'danger' : 'ghost')} type="button" disabled=${!state.lots.length} onClick=${() => confirmDel ? (onDeleteAll(), setConfirmDel(false)) : setConfirmDel(true)}>
        ${confirmDel ? `Tap again: delete all ${state.lots.length} buys from this phone` : 'Delete all buys'}</button>
    </div>
    <p class="muted small center">Portfolio v${VERSION}</p>
  </section>`;
}

// ---------- app ----------
function App() {
  const [route, setRoute] = useState(parseRoute());
  const [state, setState] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const [sort, setSort] = useState('value');
  const lastRefresh = useRef(0);
  const stRef = useRef();
  stRef.current = state;
  const toast = (text, kind, ms) => setToastMsg({ text, kind, ms });
  const patch = (p) => setState((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }));

  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [route.tab, route.ticker, !!route.form]);

  // load
  useEffect(() => {
    (async () => {
      let meta = (await db.kvGet('meta')) || {};
      if (!meta.initialized) {
        meta = { initialized: true, created: Date.now() };
        await db.kvSet('meta', meta);
      }
      const [lots, quotes, fx, settings] = await Promise.all([db.getLots(), db.kvGet('quotes'), db.kvGet('fx'), db.kvGet('settings')]);
      const persisted = await db.persist();
      setState({ lots, quotes: quotes || {}, fx, settings: { ...DEFAULT_SETTINGS, ...settings }, meta, persisted, loading: false });
    })().catch((e) => toast('Could not open storage: ' + e.message, 'error', 8000));
  }, []);

  async function refresh(force = false) {
    const s = stRef.current;
    if (!s || s.loading) return;
    if (!force && Date.now() - lastRefresh.current < MIN_REFRESH_MS) return;
    lastRefresh.current = Date.now();
    const tickers = [...new Set(s.lots.map((l) => l.ticker))];
    const hasKey = s.settings.finnhubKey || s.settings.twelveKey;
    patch({ loading: true });
    const errs = [];
    let fx = s.fx;
    try { const r = await api.fxUsdIls(); fx = { ...r, fetchedAt: Date.now() }; await db.kvSet('fx', fx); } catch (e) { errs.push('USD/ILS: ' + e.message); }
    let quotes = s.quotes;
    if (hasKey && tickers.length) {
      const res = await api.pool(tickers, 4, (t) => api.quote(t, s.settings));
      quotes = { ...quotes };
      res.forEach((r, i) => {
        if (r.ok) quotes[tickers[i]] = { ...quotes[tickers[i]], ...r.value, fetchedAt: Date.now() };
        else errs.push(`${tickers[i]}: ${r.error.message}`);
      });
      await db.kvSet('quotes', quotes);
    }
    patch({ fx, quotes, loading: false });
    if (errs.length) toast(errs.length > 2 ? `${errs.length} updates failed — ${errs[0]}` : errs.join(' · '), 'error', 7000);
  }

  useEffect(() => {
    if (!state) return;
    refresh(true);
    const vis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', vis);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5 * 60e3);
    return () => { document.removeEventListener('visibilitychange', vis); clearInterval(timer); };
  }, [!!state]);

  // pull to refresh
  const [pull, setPull] = useState(0);
  useEffect(() => {
    let y0 = null;
    const start = (e) => { y0 = window.scrollY <= 0 ? e.touches[0].clientY : null; };
    const move = (e) => { if (y0 != null) setPull(Math.max(0, Math.min(90, e.touches[0].clientY - y0))); };
    const end = () => { if (y0 != null) { setPull((p) => { if (p > 70) refresh(true); return 0; }); y0 = null; } };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end);
    return () => { window.removeEventListener('touchstart', start); window.removeEventListener('touchmove', move); window.removeEventListener('touchend', end); };
  }, []);

  const pf = useMemo(() => (state ? portfolio(state.lots, state.quotes, state.fx?.rate) : null), [state?.lots, state?.quotes, state?.fx]);

  if (!state) return html`<div class="loading">Loading…</div>`;
  const ccy = state.settings.ccy;
  const noKey = !state.settings.finnhubKey && !state.settings.twelveKey;
  const view = { ...state, noKey };

  async function saveSettings(p) {
    const settings = { ...stRef.current.settings, ...p };
    await db.kvSet('settings', settings);
    patch({ settings });
  }
  async function saveLot(lot) {
    await db.putLot(lot);
    const lots = await db.getLots();
    patch({ lots });
    toast('Saved');
    const isNew = !state.lots.some((l) => l.id === lot.id);
    if (!state.quotes[lot.ticker] && (state.settings.finnhubKey || state.settings.twelveKey)) {
      api.quote(lot.ticker, state.settings).then(async (q) => {
        const quotes = { ...stRef.current.quotes, [lot.ticker]: { ...q, fetchedAt: Date.now() } };
        await db.kvSet('quotes', quotes); patch({ quotes });
      }).catch((e) => toast(`${lot.ticker}: ${e.message}`, 'error'));
    }
    leaveTo('#t/' + encodeURIComponent(lot.ticker));
    void isNew;
  }
  async function deleteLot(id) {
    const lot = state.lots.find((l) => l.id === id);
    await db.deleteLot(id);
    patch({ lots: await db.getLots() });
    toast('Buy deleted');
    leaveTo(lot && state.lots.some((l) => l.ticker === lot.ticker && l.id !== id) ? '#t/' + encodeURIComponent(lot.ticker) : '#holdings');
  }
  async function exportBackup() {
    const data = { app: 'portfolio', schemaVersion: 1, exportedAt: new Date().toISOString(), settings: { ccy: state.settings.ccy }, lots: state.lots };
    const name = `portfolio-backup-${todayISO()}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: name });
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
    } catch (e) { if (e.name === 'AbortError') return; toast('Export failed: ' + e.message, 'error'); return; }
    const meta = { ...state.meta, lastExport: Date.now() };
    await db.kvSet('meta', meta); patch({ meta });
    toast(`Exported ${state.lots.length} buys`);
  }
  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'portfolio' || !Array.isArray(data.lots)) throw new Error('Not a portfolio backup file');
      const bad = data.lots.find((l) => !l.id || !l.ticker || !/^\d{4}-\d{2}-\d{2}$/.test(l.date) || !(l.shares > 0) || !(l.priceUsd > 0) || !(l.fxAtBuy > 0));
      if (bad) throw new Error('Invalid buy in file: ' + JSON.stringify(bad).slice(0, 80));
      await db.replaceLots(data.lots);
      patch({ lots: await db.getLots() });
      if (data.settings?.ccy) await saveSettings({ ccy: data.settings.ccy });
      toast(`Imported ${data.lots.length} buys`);
      refresh(true);
    } catch (e) { toast('Import failed: ' + e.message, 'error', 8000); }
  }
  async function deleteAll() {
    await db.replaceLots([]);
    patch({ lots: await db.getLots() });
    toast('All buys deleted');
  }

  const title = route.form ? (route.form.isNew ? 'New buy' : 'Edit buy') : route.ticker ? route.ticker : { home: 'Portfolio', holdings: 'Holdings', settings: 'Settings' }[route.tab];
  const sub = route.form || route.ticker;
  let body;
  if (route.form) body = html`<${LotForm} key=${location.hash} route=${route} lots=${state.lots} settings=${state.settings} onSave=${saveLot} onDelete=${deleteLot} toast=${toast}/>`;
  else if (route.ticker) body = html`<${Detail} ticker=${route.ticker} pf=${pf} ccy=${ccy} quotes=${state.quotes}/>`;
  else if (route.tab === 'holdings') body = html`<${Holdings} pf=${pf} ccy=${ccy} sort=${sort} setSort=${setSort}/>`;
  else if (route.tab === 'settings') body = html`<${Settings} state=${view} saveSettings=${saveSettings} onExport=${exportBackup} onImport=${importBackup} onRefresh=${refresh} onDeleteAll=${deleteAll} toast=${toast}/>`;
  else body = html`<${Home} pf=${pf} ccy=${ccy} setCcy=${(v) => saveSettings({ ccy: v })} state=${view} onRefresh=${refresh} onExport=${exportBackup} onImport=${importBackup}/>`;

  return html`
    <div class="pull" style=${`height:${pull}px;opacity:${pull / 70}`}><span class=${pull > 70 ? 'ready' : ''}><${Icon} d=${I.refresh} size=${20}/></span></div>
    <header class="top">
      ${sub ? html`<button class="icon" aria-label="Back" onClick=${() => back('holdings')}><${Icon} d=${I.back}/></button>` : html`<span class="icon-space"></span>`}
      <h1>${title}</h1>
      ${!route.form ? html`<button class=${'icon ' + (state.loading ? 'spin' : '')} aria-label="Refresh prices" onClick=${() => refresh(true)}><${Icon} d=${I.refresh}/></button>` : html`<span class="icon-space"></span>`}
    </header>
    <main>${body}</main>
    ${!route.form && route.tab !== 'settings' && html`<button class="fab" aria-label="Add a buy" onClick=${() => go('#lot/new/' + (route.ticker || ''))}><${Icon} d=${I.plus} size=${26}/></button>`}
    <nav class="tabs">
      ${[['home', 'Home', I.home], ['holdings', 'Holdings', I.list], ['settings', 'Settings', I.gear]].map(([k, t, d]) => html`
        <button class=${route.tab === k && !sub ? 'on' : route.tab === k ? 'half' : ''} aria-current=${route.tab === k ? 'page' : null} onClick=${() => goTab(k)}><${Icon} d=${d}/><span>${t}</span></button>`)}
    </nav>
    <${Toast} toast=${toastMsg} onClose=${() => setToastMsg(null)}/>`;
}

history.replaceState('root', '', location.hash || '#home');
render(html`<${App}/>`, document.getElementById('app'));

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
