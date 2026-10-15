import { html, render, useState, useEffect, useMemo, useRef } from './preact-htm.mjs';
import * as db from './db.js';
import * as api from './api.js';
import { portfolio, isStale, todayISO, txType, fifoBuyRates } from './calc.js';
import { parseIbkr, planImport, checkPositions } from './ibkr.js';
import { xlsxRows, rowsToCsv } from './xlsx.js';
import { buildHistory, changeOver, rangeStart, rebase } from './history.js';
import { LineChart } from './charts.js';

const VERSION = '2.1.0';
const DEFAULT_SETTINGS = { finnhubKey: '', twelveKey: '', ccy: 'ILS', hide: false, rateMode: 'official', lockId: null };
const MIN_REFRESH_MS = 60e3;

// ---------- formatting ----------
const MINUS = '−';
const MASK = '••••';
let HIDE = false; // "Hide amounts": personal money amounts and share counts are masked; % and market prices stay
const nf = {};
function fmtMoney(v, ccy, dec = 0, pub = false) {
  if (v == null || !isFinite(v)) return '—';
  if (HIDE && !pub) return (ccy === 'ILS' ? '₪' : '$') + MASK;
  const k = ccy + dec;
  nf[k] ||= new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, minimumFractionDigits: dec, maximumFractionDigits: dec });
  return nf[k].format(Math.abs(v)).replace(/^/, v < 0 ? MINUS : '');
}
const price = (v) => fmtMoney(v, 'USD', 2, true);
const fmtSigned = (v, ccy, dec = 0) => (v == null || !isFinite(v) ? '—' : HIDE ? fmtMoney(v, ccy) : (v > 0 ? '+' : '') + fmtMoney(v, ccy, dec));
const fmtPct = (p, dec = 2) => (p == null || !isFinite(p) ? '—' : (p > 0 ? '+' : p < 0 ? MINUS : '') + Math.abs(p * 100).toFixed(dec) + '%');
const fmtNum = (v, dec = 4) => (v == null ? '—' : Number(v.toFixed(dec)).toLocaleString('en-US', { maximumFractionDigits: dec }));
const fmtShares = (v) => (HIDE ? '••' : fmtNum(v));
const tone = (v) => (v == null || Math.abs(v) < 1e-9 ? '' : v > 0 ? 'gain' : 'loss');
function fmtCompact(v, ccy) {
  if (HIDE) return '';
  const sym = ccy === 'ILS' ? '₪' : '$', a = Math.abs(v), sign = v < 0 ? MINUS : '';
  const t = (x, d) => x.toFixed(d).replace(/\.0$/, '');
  if (a >= 1e6) return sign + sym + t(a / 1e6, a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return sign + sym + t(a / 1e3, a >= 1e4 ? 0 : 1) + 'k';
  return sign + sym + t(a, a < 10 && a > 0 ? 1 : 0);
}
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString('en-GB');
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const TYPE_LABEL = { buy: 'Buy', sell: 'Sell', div: 'Dividend', fx: 'Conversion' };
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

// ---------- routing (hash, so Android back works) ----------
function parseRoute(hash = location.hash) {
  const p = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p[0] === 'holdings') return { tab: 'holdings' };
  if (p[0] === 'settings') return { tab: 'settings' };
  if (p[0] === 'charts') return { tab: 'charts' };
  if (p[0] === 'import') return { tab: 'settings', page: 'import' };
  if (p[0] === 'conversions') return { tab: 'settings', page: 'conversions' };
  if (p[0] === 't' && p[1]) return { tab: 'holdings', ticker: p[1] };
  if ((p[0] === 'tx' || p[0] === 'lot') && p[1] === 'new') {
    const type = ['buy', 'sell', 'div', 'fx'].includes(p[2]) ? p[2] : 'buy';
    const ticker = ['buy', 'sell', 'div', 'fx'].includes(p[2]) ? p[3] || '' : p[2] || '';
    return { tab: type === 'fx' ? 'settings' : 'holdings', form: { isNew: true, type, ticker } };
  }
  if ((p[0] === 'tx' || p[0] === 'lot') && p[1]) return { tab: 'holdings', form: { id: p[1] } };
  return { tab: 'home' };
}
let prevHash = null;
const go = (hash) => { prevHash = location.hash; location.hash = hash; };
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
  chart: 'M3 3v18h18M7 15l4-5 4 3 5-7',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M17.9 17.9A10.7 10.7 0 0112 20C5 20 1 12 1 12a19.8 19.8 0 015.1-5.9M9.9 4.2A10 10 0 0112 4c7 0 11 8 11 8a19.9 19.9 0 01-2.2 3.2M1 1l22 22M14.1 14.1a3 3 0 01-4.2-4.2',
};

// ---------- small components ----------
const Pill = ({ value, dec = 2 }) => html`<span class=${'pill ' + tone(value)}>${fmtPct(value, dec)}</span>`;

function Toast({ toast, onClose }) {
  useEffect(() => { if (toast) { const t = setTimeout(onClose, toast.ms || 4000); return () => clearTimeout(t); } }, [toast]);
  if (!toast) return null;
  return html`<div class=${'toast ' + (toast.kind || '')} role="status" onClick=${onClose}>${toast.text}</div>`;
}

function Segmented({ value, options, onChange, label }) {
  return html`<div class="seg" role="group" aria-label=${label}>
    ${options.map(([v, t, disabled]) => html`<button type="button" disabled=${!!disabled} class=${value === v ? 'on' : ''} aria-pressed=${value === v} onClick=${() => onChange(v)}>${t}</button>`)}
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

function FilePick({ accept, onFile, children, cls = 'btn' }) {
  const ref = useRef();
  return html`<button type="button" class=${cls} onClick=${() => ref.current.click()}>${children}</button>
    <input type="file" accept=${accept} ref=${ref} hidden onChange=${(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onFile(f); }}/>`;
}
const ACCEPT_BACKUP = 'application/json,.json,text/plain,.txt,.csv,text/csv,text/comma-separated-values,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ACCEPT_CSV = '.csv,text/csv,text/comma-separated-values,application/vnd.ms-excel,text/plain,.txt,.json,application/json,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------- screens ----------
function Welcome({ state, onImport, onIbkr }) {
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
        <div><b>Add your investments</b><p class="muted small">Import your Interactive Brokers trades, restore a backup, or enter buys by hand.</p>
          <div class="btns">
            <${FilePick} cls="btn small primary" accept=${ACCEPT_CSV} onFile=${onIbkr}>Import from IBKR (CSV)<//>
            <${FilePick} cls="btn small" accept=${ACCEPT_BACKUP} onFile=${onImport}>Restore backup<//>
            <button class="btn small" onClick=${() => go('#tx/new/buy')}>Add a buy</button>
          </div></div>
      </div>
    </div>
  </section>`;
}

function Home({ pf, ccy, setCcy, state, onExport, onImport, onIbkr, onUndo }) {
  if (!state.lots.length) return html`<${Welcome} state=${state} onImport=${onImport} onIbkr=${onIbkr}/>`;
  const { total, holdings } = pf;
  const open = holdings.filter((h) => !h.closed);
  const C = ccy === 'ILS' ? 'Ils' : 'Usd';
  const ranked = open.filter((h) => h['totalRet' + C] != null).sort((a, b) => b['totalRet' + C] - a['totalRet' + C]);
  const gainers = ranked.filter((h) => h['totalRet' + C] > 0).slice(0, 3);
  const losers = ranked.filter((h) => h['totalRet' + C] < 0).slice(-3).reverse();
  const needBackup = !state.meta.lastExport || Date.now() - state.meta.lastExport > 30 * 864e5;
  const extra = Math.abs(total['realized' + C]) > 1e-9 || Math.abs(total['div' + C]) > 1e-9;
  const Row = (h) => html`<button class="row" onClick=${() => go('#t/' + h.ticker)}>
      <span class="tk">${h.ticker}</span>
      <span class="num muted">${fmtSigned(h['totalPl' + C], ccy)}</span>
      <${Pill} value=${h['totalRet' + C]}/>
    </button>`;
  return html`<section>
    <div class="hero">
      <div class="label">Total value</div>
      <div class="big num">${fmtMoney(total['value' + C], ccy)}</div>
      <div class="sub">
        <span class=${'num ' + tone(total['totalPl' + C])}>${fmtSigned(total['totalPl' + C], ccy)} (${fmtPct(total['totalRet' + C])})</span>
        <span class="muted"> all time</span>
      </div>
      <div class="sub small">${total['ann' + C] != null
        ? html`<span class=${tone(total['ann' + C])}>${fmtPct(total['ann' + C], 1)}</span><span class="muted"> per year (money-weighted)</span>`
        : total.annShort ? html`<span class="muted">Per-year return shows after one year of investing</span>` : ''}</div>
      ${extra && html`<div class="sub small muted breakdown">
        <span>Open <span class=${tone(total['pl' + C])}>${fmtSigned(total['pl' + C], ccy)}</span></span>
        ${Math.abs(total['realized' + C]) > 1e-9 && html`<span>Realised <span class=${tone(total['realized' + C])}>${fmtSigned(total['realized' + C], ccy)}</span></span>`}
        ${Math.abs(total['div' + C]) > 1e-9 && html`<span>Dividends <span class=${tone(total['div' + C])}>${fmtSigned(total['div' + C], ccy)}</span></span>`}</div>`}
      <div class="sub">
        ${open.some((h) => h.dayPct != null)
          ? html`<span class=${'num ' + tone(total['day' + C])}>${fmtSigned(total['day' + C], ccy)} (${fmtPct(total['dayPct' + C])})</span><span class="muted"> today</span>`
          : html`<span class="muted">Today’s change shows after the first live update</span>`}
      </div>
      <div class="hero-foot">
        <span class="muted">Invested ${fmtMoney(total['cost' + C], ccy)}</span>
        <${Segmented} label="Currency" value=${ccy} onChange=${setCcy} options=${[['ILS', '₪'], ['USD', '$']]}/>
      </div>
    </div>
    <${StatusLine} quotes=${state.quotes} fx=${state.fx} tickers=${open.map((h) => h.ticker)} loading=${state.loading} noKey=${state.noKey}/>
    ${total.missing > 0 && html`<div class="banner warn">${total.missing} buy(s) have no price yet and are left out of the totals.</div>`}
    ${total.warnings.map((w) => html`<div class="banner warn">${w}. Check your sells.</div>`)}
    ${ccy === 'ILS' && total.stockEffectIls != null && open.length > 0 && html`<div class="card split">
      <div><div class="label">Stock moves (open)</div><div class=${'num ' + tone(total.stockEffectIls)}>${fmtSigned(total.stockEffectIls, 'ILS')}</div></div>
      <div><div class="label">Currency (USD/ILS)</div><div class=${'num ' + tone(total.fxEffectIls)}>${fmtSigned(total.fxEffectIls, 'ILS')}</div></div>
    </div>`}
    ${gainers.length > 0 && html`<h2>Top gainers</h2><div class="card list">${gainers.map(Row)}</div>`}
    ${losers.length > 0 && html`<h2>Top losers</h2><div class="card list">${losers.map(Row)}</div>`}
    ${state.undo && Date.now() - state.undo.at < 864e5 && html`<div class="banner">
      <span>Imported ${state.undo.label}.</span><button class="btn small" onClick=${onUndo}>Undo</button></div>`}
    ${needBackup && html`<div class="banner">
      <span>${state.meta.lastExport ? 'Last backup over 30 days ago.' : 'No backup yet.'} Your data lives only on this phone.</span>
      <button class="btn small" onClick=${() => onExport('download')}>Back up</button>
    </div>`}
  </section>`;
}

const SORTS = { value: 'Value', pl: 'P/L', ret: 'Return', day: 'Today' };
function Holdings({ pf, ccy, sort, setSort, check }) {
  if (!pf.holdings.length) return html`<section><div class="card placeholder"><p>No investments yet.</p><button class="btn primary" onClick=${() => go('#tx/new/buy')}>Add your first buy</button></div></section>`;
  const C = ccy === 'ILS' ? 'Ils' : 'Usd';
  const key = { value: (h) => h['value' + C] ?? -Infinity, pl: (h) => h['totalPl' + C] ?? -Infinity, ret: (h) => h['totalRet' + C] ?? -Infinity, day: (h) => h.dayPct ?? -Infinity }[sort];
  const open = pf.holdings.filter((h) => !h.closed).sort((a, b) => key(b) - key(a));
  const closed = pf.holdings.filter((h) => h.closed).sort((a, b) => (b['totalPl' + C] ?? 0) - (a['totalPl' + C] ?? 0));
  const n = pf.holdings.reduce((a, h) => a + h.buys.length + h.sells.length + h.divs.length, 0);
  return html`<section>
    ${check && html`<div class=${'card check-result ' + (check.ok ? 'good' : 'bad')}>
      ${check.ok ? html`<b>✓ All ${check.count} positions match IBKR</b> <span class="small muted">on ${fmtDate(check.asOf)} (last import)</span>`
        : html`<b>${plural(check.diffs.length, 'position differs', 'positions differ')} from IBKR on ${fmtDate(check.asOf)}</b>
          <ul class="small">${check.diffs.map((d) => html`<li>${d.ticker}: app ${fmtShares(d.app)} · IBKR ${fmtShares(d.ibkr)}</li>`)}</ul>`}
    </div>`}
    <div class="chips" role="group" aria-label="Sort by">
      ${Object.entries(SORTS).map(([k, t]) => html`<button class=${'chip ' + (sort === k ? 'on' : '')} aria-pressed=${sort === k} onClick=${() => setSort(k)}>${t}</button>`)}
    </div>
    <div class="card list">
      ${open.map((h) => html`<button class="hrow" onClick=${() => go('#t/' + h.ticker)}>
        <div class="l">
          <div class="tk">${h.ticker}</div>
          <div class="muted small">${fmtShares(h.shares)} sh · avg ${price(h.avgCostUsd)}</div>
          <div class="weight"><span style=${`width:${(h.weight * 100).toFixed(1)}%`}></span></div>
        </div>
        <div class="r">
          <div class="num">${fmtMoney(h['value' + C], ccy)}</div>
          <div class="small"><span class=${'num ' + tone(h['totalPl' + C])}>${fmtSigned(h['totalPl' + C], ccy)}</span> <${Pill} value=${h['totalRet' + C]} dec=${1}/></div>
          <div class="small muted">today <span class=${tone(h.dayPct)}>${fmtPct(h.dayPct)}</span></div>
        </div>
      </button>`)}
    </div>
    ${closed.length > 0 && html`<h2>Closed positions</h2><div class="card list">
      ${closed.map((h) => html`<button class="hrow" onClick=${() => go('#t/' + h.ticker)}>
        <div class="l"><div class="tk">${h.ticker}</div><div class="muted small">sold · realised${h.divs.length ? ' + dividends' : ''}</div></div>
        <div class="r"><div class=${'num ' + tone(h['totalPl' + C])}>${fmtSigned(h['totalPl' + C], ccy)}</div><div class="small"><${Pill} value=${h['totalRet' + C]} dec=${1}/></div></div>
      </button>`)}</div>`}
    <p class="muted small center">${open.length} open · ${closed.length} closed · ${n} transactions</p>
  </section>`;
}

function Detail({ ticker, pf, ccy, quotes, closes, txns, range, setRange }) {
  const h = pf.holdings.find((x) => x.ticker === ticker);
  const C = ccy === 'ILS' ? 'Ils' : 'Usd';
  if (!h) return html`<section><p class="muted">No transactions for ${ticker}.</p><button class="btn" onClick=${() => go('#tx/new/buy/' + ticker)}>Add a buy</button></section>`;
  const q = quotes[ticker] || {};
  const S = (v) => html`<span class=${tone(v)}>${fmtSigned(v, ccy)}</span>`;
  const stats = [
    ['Shares', fmtShares(h.shares)],
    ['Avg cost', price(h.avgCostUsd)],
    ['Invested (open)', fmtMoney(h['cost' + C], ccy)],
    ['Value', fmtMoney(h['value' + C], ccy)],
    ['Open P/L', S(h['pl' + C])],
    ['Open return', html`<span class=${tone(h['ret' + C])}>${fmtPct(h['ret' + C])}</span>`],
  ];
  if (h.sells.length) stats.push(['Realised', S(h['realized' + C])]);
  if (h.divs.length) stats.push(['Dividends (net)', S(h['div' + C])]);
  stats.push(['Total P/L', S(h['totalPl' + C])], ['Total return', html`<span class=${tone(h['totalRet' + C])}>${fmtPct(h['totalRet' + C])}</span>`],
    ['Per year', h['ann' + C] != null ? html`<span class=${tone(h['ann' + C])}>${fmtPct(h['ann' + C], 1)}</span>` : html`<span class="muted small">${h.annShort ? 'after 1 year' : '—'}</span>`]);
  if (!h.closed) stats.push(['Weight', fmtPct(h.weight, 1).replace('+', '')], ['Today', S(h['day' + C])]);
  if (closes && h.price) {
    const m1 = changeOver(closes, h.price, 30, todayISO()), y1 = changeOver(closes, h.price, 365, todayISO());
    stats.push(['Price, 1 month', html`<span class=${tone(m1)}>${fmtPct(m1, 1)}</span>`], ['Price, 1 year', html`<span class=${tone(y1)}>${fmtPct(y1, 1)}</span>`]);
  }
  if (ccy === 'ILS' && !h.closed) stats.push(['Stock effect', S(h.stockEffectIls)], ['Currency effect', S(h.fxEffectIls)]);
  const openBy = new Map(h.lots.map((m) => [m.lot.id, m]));
  const activity = [...h.buys, ...h.sells, ...h.divs].sort((a, b) => b.date.localeCompare(a.date) || txType(a).localeCompare(txType(b)));
  return html`<section>
    <div class="hero compact">
      <div class="label">${q.name || ticker} · last price</div>
      <div class="big num">${price(h.price)}</div>
      <div class="sub"><span class=${tone(h.dayPct)}>${fmtPct(h.dayPct)} today</span><span class="muted"> · ${fmtAgo(q.fetchedAt)}</span></div>
    </div>
    ${h.oversold > 0 && html`<div class="banner warn">Sells exceed buys by ${fmtNum(h.oversold)} shares. Check the transactions below.</div>`}
    <div class="card grid">${stats.map(([k, v]) => html`<div><div class="label">${k}</div><div class="num">${v}</div></div>`)}</div>
    ${closes ? html`<${PriceChart} ticker=${ticker} closes=${closes} live=${h.price} txns=${txns} range=${range} setRange=${setRange}/>`
      : html`<div class="card placeholder muted small">Price chart appears once price history is downloaded (Charts tab).</div>`}
    <h2>Activity</h2>
    <div class="card list">
      ${activity.map((t) => {
        const ty = txType(t);
        const m = openBy.get(t.id);
        let line, right;
        if (ty === 'buy') {
          const left = m ? m.openShares : 0;
          line = html`${fmtShares(t.shares)} × ${price(t.priceUsd)} · ₪/$ ${t.fxAtBuy.toFixed(4)}${left < t.shares - 1e-9 ? html` · <b>${fmtShares(left)} left</b>` : ''}`;
          right = html`<div class="num">${fmtMoney((t.shares * t.priceUsd + (t.feesUsd || 0)) * (C === 'Ils' ? t.fxAtBuy : 1), ccy)}</div>
            ${m && html`<div class="small"><${Pill} value=${m['ret' + C]} dec=${1}/></div>`}`;
        } else if (ty === 'sell') {
          line = html`${fmtShares(t.shares)} × ${price(t.priceUsd)} · ₪/$ ${t.fx.toFixed(4)}`;
          right = html`<div class="num">${fmtMoney((t.shares * t.priceUsd - (t.feesUsd || 0)) * (C === 'Ils' ? t.fx : 1), ccy)}</div>`;
        } else {
          const net = t.grossUsd - (t.taxUsd || 0);
          line = html`${fmtMoney(t.grossUsd, 'USD', 2)} − US tax ${fmtMoney(t.taxUsd || 0, 'USD', 2)}`;
          right = html`<div class="num gain">${fmtSigned(net * (C === 'Ils' ? t.fx : 1), ccy, 2)}</div>`;
        }
        return html`<button class="hrow" onClick=${() => go('#tx/' + encodeURIComponent(t.id))}>
          <div class="l">
            <div><span class=${'tag ' + ty}>${TYPE_LABEL[ty]}</span> ${fmtDate(t.date)}${t.source === 'ibkr' ? html` <span class="muted small">· IBKR</span>` : ''}</div>
            <div class="muted small">${line}</div>
          </div>
          <div class="r">${right}</div>
          <span class="muted"><${Icon} d=${I.chev} size=${18}/></span>
        </button>`;
      })}
    </div>
    <div class="btns wide3">
      <button class="btn" onClick=${() => go('#tx/new/buy/' + ticker)}>+ Buy</button>
      <button class="btn" disabled=${h.closed} onClick=${() => go('#tx/new/sell/' + ticker)}>+ Sell</button>
      <button class="btn" onClick=${() => go('#tx/new/div/' + ticker)}>+ Dividend</button>
    </div>
  </section>`;
}


const RANGES = [['1M', '1M'], ['3M', '3M'], ['6M', '6M'], ['1Y', '1Y'], ['ALL', 'All']];

function HistoryStatus({ hist, onRetry, noKey }) {
  if (noKey) return html`<div class="card"><p>Charts need a free <b>Twelve Data</b> key for price history.</p><button class="btn small" onClick=${() => goTab('settings')}>Add it in Settings</button></div>`;
  if (!hist || hist.status === 'idle') return null;
  if (hist.status === 'loading') return html`<div class="status"><span class="dot busy"></span>Downloading price history ${hist.done}/${hist.total}${hist.waiting ? ' · Twelve Data allows 8 per minute, waiting…' : '…'}</div>`;
  return html`<div class="status">
    <span class=${'dot ' + (hist.errors?.length ? 'stale' : 'fresh')}></span>
    ${hist.errors?.length ? `${hist.errors.length} couldn’t load: ${hist.errors.join(' · ')}` : `History up to ${fmtDate(hist.updated || todayISO())}`}
    ${hist.errors?.length ? html` · <a href="#" onClick=${(e) => { e.preventDefault(); onRetry(); }}>retry</a>` : ''}
  </div>`;
}

function Charts({ data, ccy, hist, onRetry, noKey, range, setRange }) {
  const [mode, setMode] = useState('profit');
  if (noKey || !data) return html`<section><${HistoryStatus} hist=${hist} onRetry=${onRetry} noKey=${noKey}/>
    ${!noKey && hist?.status !== 'loading' && html`<div class="card placeholder muted small">No history yet.</div>`}</section>`;
  const C = ccy === 'ILS' ? 'Ils' : 'Usd';
  const i0 = rangeStart(data.dates, range, todayISO());
  const sl = (a) => a.slice(i0);
  const dates = sl(data.dates);
  const val = sl(data['value' + C]), inv = sl(data['invested' + C]), prof = sl(data['profit' + C]);
  const you = rebase(data['twr' + C], i0), spy = rebase(data['benchIdx' + C], i0);
  const last = val.length - 1;
  const f = (v) => fmtMoney(v, ccy);
  const ax = (v) => fmtCompact(v, ccy);
  const sym = ccy === 'ILS' ? '₪' : '$';
  const pNow = prof[last], pChg = prof[last] - prof[0];
  const g = (a) => (a[last] == null ? null : a[last] / 100 - 1);
  const yourG = g(you), spyG = g(spy);
  return html`<section>
    <div class="chips" role="group" aria-label="Time range">
      ${RANGES.map(([k, t]) => html`<button class=${'chip ' + (range === k ? 'on' : '')} aria-pressed=${range === k} onClick=${() => setRange(k)}>${t}</button>`)}
    </div>
    <${HistoryStatus} hist=${hist} onRetry=${onRetry}/>
    ${data.missing.length > 0 && html`<div class="banner warn">No price history for ${data.missing.join(', ')} — left out of the charts.</div>`}

    <div class="card chart-card">
      <div class="row-between"><h3>${mode === 'profit' ? 'Profit over time' : 'Value vs money invested'}</h3>
        <div class="chips tight" role="group" aria-label="Chart view">
          ${[['profit', 'Profit'], ['value', 'Value']].map(([k, t]) => html`<button class=${'chip small ' + (mode === k ? 'on' : '')} aria-pressed=${mode === k} onClick=${() => setMode(k)}>${t}</button>`)}
        </div></div>
      ${mode === 'profit' ? html`
        <p class="kpi"><b class=${'num ' + tone(pNow)}>${fmtSigned(pNow, ccy)}</b> <span class="muted small">total profit</span></p>
        ${range !== 'ALL' && html`<p class="small muted">Changed <span class=${tone(pChg)}>${fmtSigned(pChg, ccy)}</span> in this period.</p>`}
        <${LineChart} label="Total profit over time" dates=${dates} fmt=${(v) => fmtSigned(v, ccy)} axisFmt=${ax} zero=${true}
          series=${[{ label: 'Profit', values: prof, color: 'var(--s1)' }]}/>
        <p class="small muted">Includes open positions, sales and dividends. Buying more doesn’t move this line — only gains and losses do.</p>`
      : html`
        <p class="kpi"><b class="num">${f(val[last])}</b> <span class="muted small">value now</span></p>
        <${LineChart} label="Portfolio value and money invested over time" dates=${dates} fmt=${f} axisFmt=${ax}
          series=${[{ label: 'Value', values: val, color: 'var(--s1)' }, { label: 'Money invested', values: inv, color: 'var(--ref)', dash: true }]}/>
        <p class="small muted">Money invested = what you paid for the shares you still hold. Jumps are buys and sells.</p>`}
    </div>

    <div class="card chart-card">
      <h3>Growth of ${sym}100: you vs S&P 500</h3>
      <p class="kpi">${yourG != null && html`<span class=${'num ' + tone(yourG)}>${fmtPct(yourG, 1)}</span> <span class="muted small">you</span>`}
        ${spyG != null && html` <span class=${'num ' + tone(spyG)}>${fmtPct(spyG, 1)}</span> <span class="muted small">S&P 500</span>`}</p>
      <${LineChart} label="Growth of 100 for your portfolio and the S&P 500" dates=${dates} fmt=${(v) => sym + v.toFixed(1)} axisFmt=${(v) => sym + v.toFixed(0)}
        series=${[{ label: 'You', values: you, color: 'var(--s1)' }, { label: 'S&P 500 (SPY)', values: spy, color: 'var(--s2)' }]}/>
      <p class="small muted">How ${sym}100 would have grown with your picks vs the index, from the start of this period. Deposits and timing removed (time-weighted). Your line includes dividends; SPY is price only.</p>
    </div>

    ${ccy === 'ILS' && html`<div class="card chart-card">
      <h3>Where your shekel profit came from</h3>
      <p class="kpi"><span class=${'num ' + tone(data.stockIls.at(-1))}>${fmtSigned(data.stockIls.at(-1), 'ILS')}</span> <span class="muted small">stocks</span>
        <span class=${'num ' + tone(data.fxIls.at(-1))}>${fmtSigned(data.fxIls.at(-1), 'ILS')}</span> <span class="muted small">USD/ILS rate</span></p>
      <${LineChart} label="Shekel profit split into stock moves and currency moves" dates=${dates} fmt=${(v) => fmtSigned(v, 'ILS')} axisFmt=${(v) => fmtCompact(v, 'ILS')} zero=${true}
        series=${[{ label: 'Stock moves', values: sl(data.stockIls), color: 'var(--s1)' }, { label: 'USD/ILS rate', values: sl(data.fxIls), color: 'var(--s2)' }]}/>
      <p class="small muted">Shares you still hold. “USD/ILS rate” is what the dollar’s move since each buy added or took away.</p>
    </div>`}
  </section>`;
}

// Price chart for one stock with your buys and sells marked.
function PriceChart({ ticker, closes, live, txns, range, setRange }) {
  if (!closes) return null;
  const buys = txns.filter((t) => t.ticker === ticker && (txType(t) === 'buy' || txType(t) === 'sell'));
  if (!buys.length) return null;
  const first = buys.map((t) => t.date).sort()[0];
  const from = new Date(Date.parse(first) - 30 * 864e5).toISOString().slice(0, 10);
  let dates = Object.keys(closes).filter((d) => d >= from).sort();
  const today = todayISO();
  let prices = dates.map((d) => closes[d]);
  if (live > 0 && dates.at(-1) < today) { dates.push(today); prices.push(live); }
  else if (live > 0) prices[prices.length - 1] = live;
  // average cost of shares held, day by day
  const ev = [...buys].sort((a, b) => a.date.localeCompare(b.date));
  const lots = []; let k = 0;
  const avg = dates.map((d) => {
    while (k < ev.length && ev[k].date <= d) {
      const t = ev[k++];
      if (txType(t) === 'buy') lots.push({ rem: t.shares, per: (t.shares * t.priceUsd + (t.feesUsd || 0)) / t.shares });
      else { let q = t.shares; while (q > 1e-9 && lots.length) { const n = Math.min(q, lots[0].rem); lots[0].rem -= n; q -= n; if (lots[0].rem <= 1e-9) lots.shift(); } }
    }
    const sh = lots.reduce((a, l) => a + l.rem, 0);
    return sh > 1e-9 ? lots.reduce((a, l) => a + l.rem * l.per, 0) / sh : null;
  });
  const i0 = rangeStart(dates, range, today);
  dates = dates.slice(i0); prices = prices.slice(i0);
  const markers = ev.map((t) => ({ i: dates.findIndex((d) => d >= t.date), kind: txType(t), title: `${TYPE_LABEL[txType(t)]} ${fmtShares(t.shares)} @ ${price(t.priceUsd)}` })).filter((m) => m.i >= 0);
  return html`<div class="card chart-card">
    <div class="chips" role="group" aria-label="Time range">
      ${RANGES.map(([r, t]) => html`<button class=${'chip small ' + (range === r ? 'on' : '')} aria-pressed=${range === r} onClick=${() => setRange(r)}>${t}</button>`)}
    </div>
    <${LineChart} label=${`${ticker} price with your buys`} dates=${dates} fmt=${price} axisFmt=${(v) => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2))} markers=${markers}
      series=${[{ label: 'Price', values: prices, color: 'var(--s1)' }, { label: 'Your average cost', values: avg.slice(i0), color: 'var(--ref)', dash: true }]}/>
    <p class="small muted"><span class="mk-key buy"></span> buys${ev.some((t) => txType(t) === 'sell') ? html` · <span class="mk-key sell"></span> sells` : ''}</p>
  </div>`;
}

// One form for buys, sells, dividends and currency conversions.
function TxForm({ route, txns, pf, settings, onSave, onDelete }) {
  const existing = route.form.id ? txns.find((l) => l.id === route.form.id) : null;
  const [type, setType] = useState(existing ? txType(existing) : route.form.type || 'buy');
  const S = (v) => (v == null ? '' : String(v));
  const [f, setF] = useState(() => existing
    ? { ticker: existing.ticker || '', date: existing.date, shares: S(existing.shares), priceUsd: S(existing.priceUsd), feesUsd: S(existing.feesUsd || 0),
        rate: S(existing.fxAtBuy ?? existing.fx), grossUsd: S(existing.grossUsd), taxUsd: S(existing.taxUsd), ils: S(existing.ils), usd: S(existing.usd), note: existing.note || '' }
    : { ticker: route.form.ticker || '', date: todayISO(), shares: '', priceUsd: '', feesUsd: '0', rate: '', grossUsd: '', taxUsd: '', ils: '', usd: '', note: '' });
  const hasConv = txns.some((t) => txType(t) === 'fx');
  // Existing entries keep their stored rate unless the user picks a source again.
  const [mode, setMode] = useState(() => (existing ? existing.fxMode || 'manual' : settings.rateMode === 'fifo' && hasConv ? 'fifo' : 'official'));
  const [official, setOfficial] = useState(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [touched, setTouched] = useState(false);
  const [taxEdited, setTaxEdited] = useState(!!existing);
  const set = (k) => (e) => setF((o) => ({ ...o, [k]: e.target.value }));
  const num = (s) => Number(String(s).replace(',', '.'));

  useEffect(() => {
    if (!f.date || type === 'fx') return;
    let live = true;
    setBusy(true);
    api.officialRate(f.date >= todayISO() ? 'latest' : f.date)
      .then((r) => live && setOfficial(r.rate)).catch(() => live && setOfficial(null)).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [f.date, type]);

  // "My conversions" buys get their exact rate when saved (it depends on all your other transactions);
  // until then the official rate is shown so the form is complete.
  useEffect(() => { if (mode !== 'manual' && official && !(existing && mode === existing.fxMode)) setF((o) => ({ ...o, rate: String(+official.toFixed(6)) })); }, [official, mode]);
  useEffect(() => { if (type === 'div' && !taxEdited && num(f.grossUsd) > 0) setF((o) => ({ ...o, taxUsd: String(+(num(o.grossUsd) * 0.25).toFixed(2)) })); }, [f.grossUsd, type]);

  async function checkTicker() {
    const t = f.ticker.trim().toUpperCase();
    if (!t || (!settings.finnhubKey && !settings.twelveKey)) return;
    setCheck({ busy: true });
    try { const q = await api.quote(t, settings); setCheck({ ok: true, text: `Found · ${price(q.price)}` }); }
    catch (e) { setCheck({ ok: false, text: e.message }); }
  }

  const tk = f.ticker.trim().toUpperCase();
  const held = pf.holdings.find((h) => h.ticker === tk);
  const maxSell = (held?.shares || 0) + (existing && type === 'sell' ? existing.shares : 0);
  const errors = {};
  if (type !== 'fx' && !/^[A-Z0-9.\-]{1,10}$/.test(tk)) errors.ticker = 'Ticker like AAPL';
  if (!f.date || f.date > todayISO()) errors.date = 'Date can’t be in the future';
  if (type === 'buy' || type === 'sell') {
    if (!(num(f.shares) > 0)) errors.shares = 'More than 0';
    else if (type === 'sell' && num(f.shares) > maxSell + 1e-9) errors.shares = `You hold ${fmtNum(maxSell)}`;
    if (!(num(f.priceUsd) > 0)) errors.priceUsd = 'More than 0';
    if (!(num(f.feesUsd) >= 0)) errors.feesUsd = '0 or more';
  }
  if (type === 'div') {
    if (!(num(f.grossUsd) > 0)) errors.grossUsd = 'More than 0';
    if (!(num(f.taxUsd) >= 0) || num(f.taxUsd) > num(f.grossUsd)) errors.taxUsd = '0 up to the gross amount';
  }
  if (type === 'fx') {
    if (!(num(f.ils) > 0)) errors.ils = 'More than 0';
    if (!(num(f.usd) > 0)) errors.usd = 'More than 0';
  } else if (!(num(f.rate) > 1 && num(f.rate) < 10)) errors.rate = 'ILS per USD, e.g. 3.0573';
  const ok = Object.keys(errors).length === 0;

  function save(e) {
    e.preventDefault();
    setTouched(true);
    if (!ok) return;
    const base = { id: existing?.id || newId(), type, date: f.date, note: f.note || '', ...(existing?.source ? { source: existing.source } : {}) };
    let t;
    if (type === 'buy') t = { ...base, ticker: tk, shares: num(f.shares), priceUsd: num(f.priceUsd), feesUsd: num(f.feesUsd) || 0, fxAtBuy: num(f.rate), fxMode: mode };
    else if (type === 'sell') t = { ...base, ticker: tk, shares: num(f.shares), priceUsd: num(f.priceUsd), feesUsd: num(f.feesUsd) || 0, fx: num(f.rate) };
    else if (type === 'div') t = { ...base, ticker: tk, grossUsd: num(f.grossUsd), taxUsd: num(f.taxUsd) || 0, fx: num(f.rate) };
    else t = { ...base, ils: num(f.ils), usd: num(f.usd) };
    onSave(t);
  }
  const Err = ({ k }) => (touched && errors[k] ? html`<span class="err">${errors[k]}</span>` : null);
  const usdTotal = type === 'buy' ? num(f.shares) * num(f.priceUsd) + (num(f.feesUsd) || 0)
    : type === 'sell' ? num(f.shares) * num(f.priceUsd) - (num(f.feesUsd) || 0)
    : type === 'div' ? num(f.grossUsd) - (num(f.taxUsd) || 0) : num(f.usd);
  const rateLabel = { buy: 'USD/ILS at buy', sell: 'USD/ILS on sale date', div: 'USD/ILS on pay date' }[type];
  const rateHint = mode === 'manual' ? 'Your rate — never changed automatically'
    : type === 'buy' && mode === 'fifo' ? 'Worked out from your conversions when you save (oldest dollars first)'
    : busy ? 'Fetching rate…'
    : official ? 'Official rate for that date' : 'Couldn’t fetch — type the rate';

  return html`<form class="form" onSubmit=${save} novalidate>
    ${!existing && html`<${Segmented} label="Type" value=${type} onChange=${(v) => { setType(v); setTouched(false); }}
      options=${[['buy', 'Buy'], ['sell', 'Sell'], ['div', 'Dividend'], ['fx', 'Conversion']]}/>`}
    ${existing?.source === 'ibkr' && html`<p class="small muted">Imported from Interactive Brokers.</p>`}
    ${type !== 'fx' && html`<label>Ticker <${Err} k="ticker"/>
      <input value=${f.ticker} onInput=${set('ticker')} onBlur=${checkTicker} autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="AAPL" list=${type === 'buy' ? null : 'held'}/>
      <datalist id="held">${pf.holdings.filter((h) => !h.closed).map((h) => html`<option value=${h.ticker}/>`)}</datalist>
      ${check && html`<span class=${'hint ' + (check.busy ? '' : check.ok ? 'gain' : 'loss')}>${check.busy ? 'Checking…' : check.text}</span>`}
      ${type === 'sell' && held && html`<span class="hint muted">You hold ${fmtShares(maxSell)} shares</span>`}
    </label>`}
    <label>${{ buy: 'Buy date', sell: 'Sale date', div: 'Pay date', fx: 'Conversion date' }[type]} <${Err} k="date"/>
      <input type="date" value=${f.date} max=${todayISO()} onInput=${set('date')}/></label>
    ${(type === 'buy' || type === 'sell') && html`
      <div class="two">
        <label>Shares <${Err} k="shares"/><input inputmode="decimal" value=${f.shares} onInput=${set('shares')} placeholder="10"/></label>
        <label>Price per share (USD) <${Err} k="priceUsd"/><input inputmode="decimal" value=${f.priceUsd} onInput=${set('priceUsd')} placeholder="310.25"/></label>
      </div>
      <label>Fees / commission (USD) <${Err} k="feesUsd"/><input inputmode="decimal" value=${f.feesUsd} onInput=${set('feesUsd')}/></label>`}
    ${type === 'div' && html`
      <div class="two">
        <label>Gross dividend (USD) <${Err} k="grossUsd"/><input inputmode="decimal" value=${f.grossUsd} onInput=${set('grossUsd')} placeholder="7.04"/></label>
        <label>US tax withheld (USD) <${Err} k="taxUsd"/><input inputmode="decimal" value=${f.taxUsd} onInput=${(e) => { setTaxEdited(true); set('taxUsd')(e); }}/>
          <span class="hint muted">${taxEdited ? 'Your amount' : '25% filled in — edit to your statement'}</span></label>
      </div>`}
    ${type === 'fx' && html`
      <p class="small muted">Log each time you converted shekels to dollars. With “Cost rate: My conversions”, each buy is costed from the dollars it actually used.</p>
      <div class="two">
        <label>Shekels paid (ILS) <${Err} k="ils"/><input inputmode="decimal" value=${f.ils} onInput=${set('ils')} placeholder="10000"/></label>
        <label>Dollars received (USD) <${Err} k="usd"/><input inputmode="decimal" value=${f.usd} onInput=${set('usd')} placeholder="3270"/></label>
      </div>`}
    ${type !== 'fx' && html`<label>${rateLabel} <${Err} k="rate"/>
      ${type === 'buy' && html`<${Segmented} label="Rate source" value=${mode} onChange=${setMode}
        options=${[['official', 'Official'], ['fifo', 'My conversions', !hasConv], ['manual', 'Custom']]}/>`}
      <input inputmode="decimal" value=${f.rate} onInput=${(e) => { setMode('manual'); set('rate')(e); }} placeholder=${busy ? 'loading…' : '3.0573'}/>
      <span class="hint muted">${rateHint}</span></label>`}
    <label>Note<input value=${f.note} onInput=${set('note')} placeholder="optional"/></label>
    <div class="card summary">
      <span class="muted">${{ buy: 'Total cost', sell: 'Proceeds after fees', div: 'Net received', fx: 'Rate' }[type]}</span>
      <span class="num">${type === 'fx'
        ? (num(f.ils) > 0 && num(f.usd) > 0 ? `₪${(num(f.ils) / num(f.usd)).toFixed(4)} per $` : '—')
        : isFinite(usdTotal) && usdTotal > 0 ? `${fmtMoney(usdTotal, 'USD', 2)}${num(f.rate) > 0 ? ' · ' + fmtMoney(usdTotal * num(f.rate), 'ILS', 2) : ''}` : '—'}</span>
    </div>
    <button class="btn wide primary" type="submit">${existing ? 'Save changes' : 'Add ' + TYPE_LABEL[type].toLowerCase()}</button>
    ${existing && html`<button type="button" class=${'btn wide ' + (confirmDel ? 'danger' : 'ghost')} onClick=${() => (confirmDel ? onDelete(existing.id) : setConfirmDel(true))}>
      ${confirmDel ? 'Tap again to delete' : 'Delete this ' + TYPE_LABEL[type].toLowerCase()}</button>`}
  </form>`;
}

function ImportPreview({ pending, resultOf, onConfirm, onCancel }) {
  const [nearOn, setNearOn] = useState(() => new Set((pending?.plan.near || []).map((n, i) => i)));
  const [master, setMaster] = useState(false);
  if (!pending) return html`<section><p class="muted">Nothing to import. Pick a file in Settings.</p></section>`;
  const { plan, skipped, format, fileName, positions } = pending;
  const c = plan.counts;
  const total = plan.add.length;
  const nearIds = plan.near.filter((n, i) => nearOn.has(i)).flatMap((n) => n.ids);
  const opts = { nearIds, master };
  const { remove, list } = resultOf(pending, opts);
  const check = checkPositions(list, positions);
  const extraManual = plan.manualIds.filter((id) => !remove.has(id) || master).length;
  const toggle = (i) => setNearOn((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  return html`<section>
    <div class="card">
      <p class="small muted">${fileName} · ${format}</p>
      ${total === 0 ? html`<p><b>Nothing new.</b> All ${plan.duplicates} transactions in this file are already in the app.</p>` : html`
        <ul class="plain">
          ${c.buy > 0 && html`<li>${plural(c.buy, 'buy', 'buys')}</li>`}
          ${c.sell > 0 && html`<li>${plural(c.sell, 'sell', 'sells')}</li>`}
          ${c.div > 0 && html`<li>${plural(c.div, 'dividend', 'dividends')}</li>`}
          ${c.fx > 0 && html`<li>${plural(c.fx, 'currency conversion', 'currency conversions')} (USD.ILS)</li>`}
        </ul>
        ${plan.removeIds.length > 0 && html`<p class="small">${plural(plan.removeIds.length, 'buy', 'buys')} you entered by hand match IBKR trades (same stock, day and shares) and will be <b>replaced</b> by the exact IBKR versions.</p>`}
        ${plan.duplicates > 0 && html`<p class="small muted">${plan.duplicates} already imported earlier — skipped.</p>`}`}
      ${skipped.length > 0 && html`<details class="small"><summary>${plural(skipped.length, 'row', 'rows')} not imported</summary><ul>${skipped.map((s) => html`<li>${s}</li>`)}</ul></details>`}
    </div>
    ${plan.near.length > 0 && html`<h2>Possible duplicates</h2><div class="card form">
      <p class="small muted">Same stock and number of shares, but the dates differ by 1–3 days (often trade date vs settlement date). Ticked = replace yours with IBKR’s.</p>
      ${plan.near.map((n, i) => html`<label class="check"><input type="checkbox" checked=${nearOn.has(i)} onChange=${() => toggle(i)}/>
        <span>${n.ticker} · ${fmtNum(n.shares)} shares — yours ${fmtDate(n.manualDate)}, IBKR ${fmtDate(n.ibkrDate)}</span></label>`)}
    </div>`}
    ${plan.manualIds.length > 0 && html`<div class="card form"><label class="check"><input type="checkbox" checked=${master} onChange=${(e) => setMaster(e.target.checked)}/>
      <span>IBKR is the master: also remove ${plural(plan.manualIds.length, 'other entry', 'other entries')} you added by hand between ${fmtDate(pending.period?.from || plan.span?.from || '')} and ${fmtDate(pending.period?.to || plan.span?.to || '')}</span></label></div>`}
    ${check && html`<div class=${'card check-result ' + (check.ok ? 'good' : 'bad')}>
      ${check.ok ? html`<b>✓ All ${check.count} positions will match IBKR</b> <span class="small muted">on ${fmtDate(check.asOf)}</span>`
        : html`<b>After this import, ${plural(check.diffs.length, 'position differs', 'positions differ')} from IBKR on ${fmtDate(check.asOf)}:</b>
          <ul class="small">${check.diffs.map((d) => html`<li>${d.ticker}: app ${fmtNum(d.app)} · IBKR ${fmtNum(d.ibkr)}</li>`)}</ul>
          <p class="small muted">Usually a missing earlier file (import older statements too) or a hand-entered duplicate.</p>`}
    </div>`}
    <p class="small muted">Buys get their shekel cost from your “Cost rate” setting; sells and dividends use the official rate of their date. You can undo this import in Settings.</p>
    <button class="btn wide primary" disabled=${total === 0 && remove.size === 0} onClick=${() => onConfirm(opts)}>Import ${plural(total, 'transaction', 'transactions')}</button>
    <button class="btn wide ghost" onClick=${onCancel}>Cancel</button>
  </section>`;
}

function Conversions({ txns }) {
  const list = txns.filter((t) => txType(t) === 'fx').sort((a, b) => b.date.localeCompare(a.date));
  const usd = list.reduce((a, t) => a + t.usd, 0), ils = list.reduce((a, t) => a + t.ils, 0);
  return html`<section>
    <div class="card row-between"><span>${plural(list.length, 'conversion', 'conversions')} · net ${fmtMoney(usd, 'USD')}</span><b class="num">${usd > 0 ? '₪' + (ils / usd).toFixed(4) + ' per $ overall' : '—'}</b></div>
    <div class="card list">
      ${list.length === 0 && html`<p class="muted small" style="padding:14px 16px">No conversions yet.</p>`}
      ${list.map((t) => html`<button class="hrow" onClick=${() => go('#tx/' + encodeURIComponent(t.id))}>
        <div class="l"><div>${fmtDate(t.date)}${t.source === 'ibkr' ? html` <span class="muted small">· IBKR</span>` : ''}</div>
          <div class="muted small">${t.usd > 0 ? html`${fmtMoney(t.ils, 'ILS', 2)} → ${fmtMoney(t.usd, 'USD', 2)}` : html`${fmtMoney(-t.usd, 'USD', 2)} → ${fmtMoney(-t.ils, 'ILS', 2)} (dollars sold)`}</div></div>
        <div class="r num">₪${(t.ils / t.usd).toFixed(4)}</div>
        <span class="muted"><${Icon} d=${I.chev} size=${18}/></span>
      </button>`)}
    </div>
    <button class="btn wide" onClick=${() => go('#tx/new/fx')}>Add a conversion</button>
  </section>`;
}

function Settings({ state, saveSettings, onExport, onImport, onIbkr, onRefresh, onDeleteAll, onRecalc, onUndo, onLock, toast }) {
  const s = state.settings;
  const [keys, setKeys] = useState({ finnhubKey: s.finnhubKey, twelveKey: s.twelveKey });
  const [show, setShow] = useState(false);
  const [test, setTest] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const dirty = keys.finnhubKey !== s.finnhubKey || keys.twelveKey !== s.twelveKey;
  const nConv = state.lots.filter((t) => txType(t) === 'fx').length;
  const SOURCE = { boi: 'Bank of Israel representative rate', ecb: 'European Central Bank rate (Bank of Israel unreachable)' };

  async function runTest() {
    setTest({ busy: true });
    const res = {};
    const t = async (name, fn) => { try { res[name] = { ok: true, text: await fn() }; } catch (e) { res[name] = { ok: false, text: e.message }; } };
    await Promise.all([
      keys.finnhubKey ? t('Finnhub', async () => `SPY ${price((await api.finnhubQuote('SPY', keys.finnhubKey.trim())).price)}`) : (res.Finnhub = { ok: false, text: 'No key' }),
      keys.twelveKey ? t('Twelve Data', async () => `SPY ${price((await api.twelveQuote('SPY', keys.twelveKey.trim())).price)}`) : (res['Twelve Data'] = { ok: false, text: 'No key' }),
      t('Exchange rate', async () => { const r = await api.officialRate('latest'); return `USD/ILS ${r.rate} (${fmtDate(r.date)}, ${r.source === 'boi' ? 'Bank of Israel' : 'ECB via Frankfurter'})`; }),
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

    <h2>Import from Interactive Brokers</h2>
    <div class="card form">
      <ol class="small muted steps-list">
        <li>In IBKR (Client Portal / website): <b>Performance & Reports → Statements → Activity</b>.</li>
        <li>Period: <b>Custom</b>, from your first trade to today. Format: <b>CSV</b>. Run → Download.</li>
        <li>Pick that file below (CSV, or the same file opened/saved in Excel or Google Sheets). Re-import any time — already imported trades are skipped.</li>
      </ol>
      <${FilePick} accept=${ACCEPT_CSV} onFile=${onIbkr}>Choose IBKR CSV file<//>
      <p class="small muted">Reads stock buys and sells, USD.ILS conversions, dividends and US tax withheld.</p>
    </div>

    <h2>Currency conversions</h2>
    <div class="card form">
      <div class="row-between"><span>${plural(nConv, 'conversion', 'conversions')}</span>
        <button class="btn small" type="button" onClick=${() => go('#conversions')}>View / add</button></div>
      <div class="row-between"><span>Cost rate for buys</span>
        <${Segmented} label="Cost rate for buys" value=${s.rateMode} onChange=${async (v) => { await saveSettings({ rateMode: v }); onRecalc(); }}
          options=${[['official', 'Official'], ['fifo', 'My conversions', !nConv]]}/></div>
      <p class="small muted">${s.rateMode === 'fifo'
        ? 'Each buy is costed from the dollars it actually used: your conversions, oldest dollars first (dollars converted the same day count). If you had no converted dollars left, the official rate is used.'
        : 'Each buy uses the official USD/ILS rate of its date.'} Buys where you typed a custom rate are never changed.</p>
      <p class="small muted">Official rate source: ${SOURCE[state.fx?.source] || 'not fetched yet'}.</p>
      <button class="btn" type="button" onClick=${onRecalc}>Recalculate all buys</button>
    </div>

    <h2>Display</h2>
    <div class="card form">
      <div class="row-between"><span>Main currency</span>
        <${Segmented} label="Main currency" value=${s.ccy} onChange=${(v) => saveSettings({ ccy: v })} options=${[['ILS', '₪ ILS'], ['USD', '$ USD']]}/></div>
      <div class="row-between"><span>Hide amounts <span class="small muted">(eye button at the top)</span></span>
        <${Segmented} label="Hide amounts" value=${s.hide ? 'on' : 'off'} onChange=${(v) => saveSettings({ hide: v === 'on' })} options=${[['off', 'Show'], ['on', 'Hide']]}/></div>
    </div>

    <h2>Security</h2>
    <div class="card form">
      <div class="row-between"><span>Fingerprint lock</span>
        <${Segmented} label="Fingerprint lock" value=${s.lockId ? 'on' : 'off'} onChange=${(v) => onLock(v === 'on')} options=${[['off', 'Off'], ['on', 'On']]}/></div>
      <p class="small muted">Asks for your fingerprint (or screen lock) when the app opens or returns after a minute in the background. It hides the screen from others; it doesn’t encrypt the data.</p>
    </div>

    <h2>Backup</h2>
    <div class="card form">
      <p class="small muted">Last backup: ${state.meta.lastExport ? new Date(state.meta.lastExport).toLocaleString('en-GB') : 'never'} · storage ${state.persisted ? 'protected' : 'not protected'}</p>
      <div class="two">
        <button class="btn" type="button" onClick=${() => onExport('download')}>Export JSON</button>
        <${FilePick} accept=${ACCEPT_BACKUP} onFile=${onImport}>Import JSON<//>
      </div>
      <button class="btn" type="button" onClick=${() => onExport('share')}>Share backup to Drive / WhatsApp / email…</button>
      <p class="small muted">Importing a backup replaces everything on this phone with the file’s contents.</p>
    </div>

    <h2>Data</h2>
    <div class="card form">
      <button class="btn" type="button" onClick=${() => onRefresh(true)}>Refresh prices now</button>
      ${state.undo && html`<button class="btn" type="button" onClick=${onUndo}>Undo last import (${state.undo.label}, ${new Date(state.undo.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })})</button>`}
      <button class=${'btn ' + (confirmDel ? 'danger' : 'ghost')} type="button" disabled=${!state.lots.length} onClick=${() => (confirmDel ? (onDeleteAll(), setConfirmDel(false)) : setConfirmDel(true))}>
        ${confirmDel ? `Tap again: delete all ${state.lots.length} transactions from this phone` : 'Delete all transactions'}</button>
    </div>
    <p class="muted small center">Portfolio v${VERSION}</p>
  </section>`;
}

// ---------- backup validation ----------
function validTx(t) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t?.date);
  if (!t || !t.id || !d) return false;
  switch (txType(t)) {
    case 'buy': return !!t.ticker && t.shares > 0 && t.priceUsd > 0 && t.fxAtBuy > 0;
    case 'sell': return !!t.ticker && t.shares > 0 && t.priceUsd > 0 && t.fx > 0;
    case 'div': return !!t.ticker && t.grossUsd > 0 && t.fx > 0;
    case 'fx': return t.ils !== 0 && t.usd !== 0 && Math.sign(t.ils) === Math.sign(t.usd);
    default: return false;
  }
}

// ---------- price history (Twelve Data free plan: 8 requests per minute) ----------
const tdCalls = [];
async function paced(fn, onWait) {
  for (;;) {
    const now = Date.now();
    while (tdCalls.length && now - tdCalls[0] > 61e3) tdCalls.shift();
    if (tdCalls.length < 8) break;
    onWait?.(true);
    await new Promise((r) => setTimeout(r, 61e3 - (now - tdCalls[0]) + 200));
  }
  onWait?.(false);
  tdCalls.push(Date.now());
  return fn();
}
const minus = (iso, d) => new Date(Date.parse(iso) - d * 864e5).toISOString().slice(0, 10);

// ---------- fingerprint lock (WebAuthn platform authenticator; a privacy screen, not encryption) ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function createLock() {
  if (!window.PublicKeyCredential || !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()))
    throw new Error('This phone doesn’t offer fingerprint or screen-lock for web apps');
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'Portfolio' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'portfolio', displayName: 'Portfolio app' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    timeout: 60000, attestation: 'none' } });
  return b64u(cred.rawId);
}
async function verifyLock(id) {
  await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: 'public-key', id: unb64u(id) }], userVerification: 'required', timeout: 60000 } });
}

function LockScreen({ onUnlock, onDisable, fails }) {
  useEffect(() => { onUnlock(); }, []);
  const [sure, setSure] = useState(false);
  return html`<div class="lock">
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>
    <h1>Portfolio is locked</h1>
    <button class="btn primary" onClick=${onUnlock}>Unlock with fingerprint</button>
    ${fails >= 3 && html`<button class=${'btn ' + (sure ? 'danger' : 'ghost')} onClick=${() => (sure ? onDisable() : setSure(true))}>
      ${sure ? 'Tap again to turn the lock off (your data stays)' : 'Fingerprint not working?'}</button>`}
  </div>`;
}

// ---------- app ----------
function App() {
  const [route, setRoute] = useState(parseRoute());
  const [state, setState] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const [sort, setSort] = useState('value');
  const [range, setRange] = useState('ALL');
  const [pRange, setPRange] = useState('1Y');
  const [hist, setHist] = useState({ status: 'idle', closes: {}, fx: {} });
  const histRef = useRef(false);
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
  useEffect(() => { window.scrollTo(0, 0); }, [route.tab, route.ticker, !!route.form, route.page]);

  useEffect(() => {
    (async () => {
      let meta = (await db.kvGet('meta')) || {};
      if (!meta.initialized) { meta = { initialized: true, created: Date.now() }; await db.kvSet('meta', meta); }
      let [lots, quotes, fx, settings] = await Promise.all([db.getLots(), db.kvGet('quotes'), db.kvGet('fx'), db.kvGet('settings')]);
      if (lots.some((t) => t.fxMode === 'conv')) { lots = lots.map((t) => (t.fxMode === 'conv' ? { ...t, fxMode: 'fifo' } : t)); await db.replaceLots(lots); }
      const persisted = await db.persist();
      const st = { ...DEFAULT_SETTINGS, ...settings };
      if (st.rateMode === 'conv') st.rateMode = 'fifo'; // v1.2 "average" mode is replaced by exact FIFO matching
      const undo = await db.kvGet('undo');
      setState({ lots, quotes: quotes || {}, fx, settings: st, meta, persisted, loading: false, pending: null,
        undo: undo && Date.now() - undo.at < 7 * 864e5 ? { at: undo.at, label: undo.label } : null, locked: !!st.lockId });
    })().catch((e) => toast('Could not open storage: ' + e.message, 'error', 8000));
  }, []);

  const pf = useMemo(() => (state ? portfolio(state.lots, state.quotes, state.fx?.rate) : null), [state?.lots, state?.quotes, state?.fx]);

  async function refresh(force = false) {
    const s = stRef.current;
    if (!s || s.loading) return;
    if (!force && Date.now() - lastRefresh.current < MIN_REFRESH_MS) return;
    lastRefresh.current = Date.now();
    const p = portfolio(s.lots, s.quotes, s.fx?.rate);
    const tickers = p.holdings.filter((h) => !h.closed).map((h) => h.ticker);
    const hasKey = s.settings.finnhubKey || s.settings.twelveKey;
    patch({ loading: true });
    const errs = [];
    let fx = s.fx;
    try { const r = await api.officialRate('latest'); fx = { ...r, fetchedAt: Date.now() }; await db.kvSet('fx', fx); } catch (e) { errs.push('USD/ILS: ' + e.message); }
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

  // Download (or top up) daily closes for every stock ever held + SPY, and daily USD/ILS. Cached on the phone.
  async function ensureHistory(force = false) {
    const s = stRef.current;
    if (!s || histRef.current || !s.settings.twelveKey) return;
    const stockTx = s.lots.filter((t) => txType(t) === 'buy' || txType(t) === 'sell');
    if (!stockTx.length) return;
    histRef.current = true;
    const today = todayISO();
    const firstOf = {};
    for (const t of stockTx) if (!firstOf[t.ticker] || t.date < firstOf[t.ticker]) firstOf[t.ticker] = t.date;
    const first = Object.values(firstOf).sort()[0];
    firstOf.SPY = first;
    const cached = (await db.kvGet('hist')) || { closes: {}, meta: {} };
    const closes = { ...cached.closes }, meta = { ...cached.meta };
    const todo = Object.keys(firstOf).filter((tk) => force || !meta[tk] || meta[tk].day !== today || meta[tk].from > minus(firstOf[tk], 35));
    const errors = [];
    setHist((h) => ({ ...h, status: 'loading', done: 0, total: todo.length, closes, fx: h.fx }));
    let done = 0;
    for (const tk of todo) {
      const want = minus(firstOf[tk], 35);
      const have = meta[tk] && meta[tk].from <= want ? meta[tk].to : null;
      try {
        const got = await paced(() => api.dailyCloses(tk, s.settings.twelveKey, have ? minus(have, 3) : want), (w) => setHist((h) => ({ ...h, waiting: w })));
        closes[tk] = { ...(have ? closes[tk] : {}), ...got };
        const ds = Object.keys(closes[tk]).sort();
        meta[tk] = { from: have ? meta[tk].from : want, to: ds.at(-1) || want, day: today };
      } catch (e) { errors.push(`${tk}: ${e.message}`); }
      done++;
      setHist((h) => ({ ...h, done, closes: { ...closes } }));
      await db.kvSet('hist', { closes, meta });
    }
    let fx = cached.fx || {};
    try { fx = await api.officialSeries(minus(first, 10)); await db.kvSet('hist', { closes, meta, fx }); } catch (e) { if (!Object.keys(fx).length) errors.push('USD/ILS: ' + e.message); }
    setHist({ status: 'ready', closes, fx, errors, updated: today });
    histRef.current = false;
  }
  // Show cached history immediately, then top up when the Charts tab or a stock page is opened
  useEffect(() => { db.kvGet('hist').then((c) => { if (c) setHist((h) => (h.status === 'idle' ? { status: 'cached', closes: c.closes || {}, fx: c.fx || {} } : h)); }).catch(() => {}); }, []);
  useEffect(() => { if (state && !state.locked && (route.tab === 'charts' || route.ticker)) ensureHistory(); }, [route.tab, route.ticker, !!state, state?.locked, state?.settings.twelveKey]);
  const histData = useMemo(() => {
    if (!state || !Object.keys(hist.closes || {}).length || !hist.closes.SPY) return null;
    const live = Object.fromEntries(Object.entries(state.quotes).filter(([, q]) => q?.price > 0 && q.fetchedAt && Date.now() - q.fetchedAt < 864e5).map(([k, q]) => [k, q.price]));
    return buildHistory({ txns: state.lots, closes: hist.closes, fx: hist.fx || {}, bench: hist.closes.SPY, today: todayISO(), live, liveFx: state.fx?.rate });
  }, [state?.lots, state?.quotes, state?.fx, hist]);

  // New version published? (version.json is never cached)
  const [newVersion, setNewVersion] = useState(null);
  useEffect(() => {
    const check = () => fetch('./version.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j?.version && j.version !== VERSION) setNewVersion(j.version); }).catch(() => {});
    check();
    const t = setInterval(check, 30 * 60e3);
    const vis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);
  // Re-lock after a minute in the background
  useEffect(() => {
    let hiddenAt = 0;
    const vis = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60e3 && stRef.current?.settings.lockId) patch({ locked: true });
    };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);
  const [lockFails, setLockFails] = useState(0);

  if (!state) return html`<div class="loading">Loading…</div>`;
  HIDE = !!state.settings.hide;
  const ccy = state.settings.ccy;
  const noKey = !state.settings.finnhubKey && !state.settings.twelveKey;
  const view = { ...state, noKey };

  async function saveSettings(p) {
    const settings = { ...stRef.current.settings, ...p };
    await db.kvSet('settings', settings);
    patch({ settings });
  }
  const reload = async () => patch({ lots: await db.getLots() });

  // Throw away the saved copy, download every app file fresh (bypassing the browser cache), then restart.
  async function applyUpdate() {
    patch({ loading: true });
    try {
      await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
      const files = ['./', './index.html', './styles.css', './app.js', './calc.js', './db.js', './api.js', './ibkr.js', './xlsx.js', './history.js', './charts.js', './preact-htm.mjs', './manifest.webmanifest', './sw.js'];
      await Promise.all(files.map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
      await (await navigator.serviceWorker?.getRegistration())?.update();
    } catch {}
    location.reload();
  }
  async function setLock(on) {
    if (!on) { await saveSettings({ lockId: null }); return toast('Fingerprint lock off'); }
    try { const id = await createLock(); await saveSettings({ lockId: id }); toast('Fingerprint lock on'); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Cancelled' : 'Couldn’t turn on the lock: ' + e.message, 'error', 8000); }
  }
  async function unlock() {
    try { await verifyLock(state.settings.lockId); patch({ locked: false }); setLockFails(0); }
    catch (e) { setLockFails((n) => n + 1); }
  }
  if (state.locked) {
    return html`<${LockScreen} fails=${lockFails} onUnlock=${unlock} onDisable=${async () => { await saveSettings({ lockId: null }); patch({ locked: false }); }}/>
      <${Toast} toast=${toastMsg} onClose=${() => setToastMsg(null)}/>`;
  }

  // Official USD/ILS for many dates in one request.
  async function officialRates(dates) {
    const from = dates.reduce((a, d) => (d < a ? d : a), todayISO());
    const start = new Date(Date.parse(from) - 10 * 864e5).toISOString().slice(0, 10); // earlier, for weekends/holidays
    const series = await api.officialSeries(start);
    return (d) => api.rateOn(series, d);
  }
  // Assign each buy its shekel cost rate (unless the user typed one). Returns the updated list and how many changed.
  // all=true ("Apply to all existing buys"): every buy follows the setting. Otherwise each buy keeps its own source.
  async function withRates(txns, all = false) {
    const mode = stRef.current.settings.rateMode;
    const need = txns.filter((t) => txType(t) !== 'fx').map((t) => t.date);
    if (!need.length) return { next: txns, changed: 0 };
    const official = await officialRates(need);
    // sells and dividends first: their rate feeds the dollar pool used by later buys
    txns = txns.map((t) => ((txType(t) === 'sell' || txType(t) === 'div') && !(t.fx > 0) ? { ...t, fx: official(t.date), _new: 1 } : t));
    const fifoMap = fifoBuyRates(txns, official);
    let changed = 0;
    const next = txns.map((t) => {
      const ty = txType(t);
      if (t._new) { changed++; const { _new, ...rest } = t; return rest; }
      if (ty !== 'buy' || t.fxMode === 'manual') return t;
      const useFifo = all || !t.fxMode || !(t.fxAtBuy > 0) ? mode === 'fifo' : t.fxMode === 'fifo';
      if (!all && t.fxMode === 'official' && t.fxAtBuy > 0) return t; // already set, keep
      const r = useFifo ? fifoMap.get(t.id).rate : official(t.date);
      const m = useFifo ? 'fifo' : 'official';
      if (!(r > 0)) return t;
      if (Math.abs(r - (t.fxAtBuy || 0)) > 1e-9 || t.fxMode !== m) changed++;
      return { ...t, fxAtBuy: r, fxMode: m };
    });
    return { next, changed };
  }
  // In "My conversions" mode every change can shift later buys' rates, so recompute quietly.
  async function syncRates() {
    if (!stRef.current.lots.some((t) => t.fxMode === 'fifo')) return;
    try { const { next, changed } = await withRates(stRef.current.lots); if (changed) { await db.replaceLots(next); await reload(); } } catch {}
  }

  async function saveTx(t) {
    await db.putLot(t);
    await reload();
    toast('Saved');
    await syncRates();
    const s = stRef.current;
    if (t.ticker && !s.quotes[t.ticker] && (s.settings.finnhubKey || s.settings.twelveKey)) {
      api.quote(t.ticker, s.settings).then(async (q) => {
        const quotes = { ...stRef.current.quotes, [t.ticker]: { ...q, fetchedAt: Date.now() } };
        await db.kvSet('quotes', quotes); patch({ quotes });
      }).catch((e) => toast(`${t.ticker}: ${e.message}`, 'error'));
    }
    leaveTo(t.type === 'fx' ? '#conversions' : '#t/' + encodeURIComponent(t.ticker));
  }
  async function deleteTx(id) {
    const t = state.lots.find((l) => l.id === id);
    await db.deleteLot(id);
    await reload();
    toast('Deleted');
    await syncRates();
    if (txType(t) === 'fx') return leaveTo('#conversions');
    leaveTo(state.lots.some((l) => l.ticker === t.ticker && l.id !== id) ? '#t/' + encodeURIComponent(t.ticker) : '#holdings');
  }

  async function exportBackup(mode = 'download') {
    const data = { app: 'portfolio', schemaVersion: 2, exportedAt: new Date().toISOString(), settings: { ccy: state.settings.ccy, rateMode: state.settings.rateMode }, transactions: state.lots };
    const text = JSON.stringify(data, null, 2);
    const base = `portfolio-backup-${todayISO()}`;
    const download = () => {
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = base + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    let how = 'Saved to Downloads';
    if (mode === 'share') {
      const file = new File([text], base + '.txt', { type: 'text/plain' });
      try {
        if (!navigator.canShare?.({ files: [file] })) throw new Error('not supported');
        await navigator.share({ files: [file], title: base });
        how = 'Shared';
      } catch (e) {
        if (e.name === 'AbortError') return;
        try { download(); how = 'Sharing not allowed here — saved to Downloads instead'; } catch (e2) { toast('Export failed: ' + e2.message, 'error', 8000); return; }
      }
    } else {
      try { download(); } catch (e) { toast('Export failed: ' + e.message, 'error', 8000); return; }
    }
    const meta = { ...state.meta, lastExport: Date.now() };
    await db.kvSet('meta', meta); patch({ meta });
    toast(`${how} · ${state.lots.length} transactions`, '', 6000);
  }
  // Any file button accepts either kind of file: a backup (JSON) or an IBKR statement (CSV).
  async function importAny(file) {
    let text;
    try {
      const buf = await file.arrayBuffer();
      const sig = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      if (sig[0] === 0x50 && sig[1] === 0x4b) text = rowsToCsv(await xlsxRows(buf)); // "PK": an Excel/Google Sheets file
      else text = new TextDecoder().decode(buf);
    } catch (e) { return toast('Couldn’t read the file: ' + e.message, 'error', 9000); }
    const head = text.replace(/^[\uFEFF\u200B\s]+/, '');
    if (head.startsWith('{')) return importBackup(head);
    return pickIbkr(head, file.name);
  }
  async function importBackup(text) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data.transactions) ? data.transactions : data.lots;
      if (data.app !== 'portfolio' || !Array.isArray(list)) throw new Error('Not a portfolio backup file');
      const bad = list.find((t) => !validTx(t));
      if (bad) throw new Error('Invalid entry in file: ' + JSON.stringify(bad).slice(0, 80));
      await db.replaceLots(list);
      await reload();
      const keep = {};
      if (data.settings?.ccy) keep.ccy = data.settings.ccy;
      if (data.settings?.rateMode) keep.rateMode = data.settings.rateMode;
      if (Object.keys(keep).length) await saveSettings(keep);
      toast(`Imported ${list.length} transactions`);
      refresh(true);
    } catch (e) { toast('Import failed: ' + e.message, 'error', 8000); }
  }
  async function pickIbkr(text, fileName) {
    try {
      const parsed = parseIbkr(text);
      if (!parsed.txns.length) throw new Error('No stock trades, conversions or dividends found in this file' + (parsed.skipped.length ? ` (${parsed.skipped.length} rows skipped)` : ''));
      const plan = planImport(stRef.current.lots, parsed.txns, parsed.period);
      if (!plan.add.length && parsed.positions) { // nothing to import, but still check positions against this statement
        const check = checkPositions(stRef.current.lots, parsed.positions);
        const meta = { ...stRef.current.meta, lastCheck: check };
        await db.kvSet('meta', meta); patch({ meta });
      }
      patch({ pending: { plan, period: parsed.period, positions: parsed.positions, skipped: parsed.skipped, format: parsed.format, fileName } });
      go('#import');
    } catch (e) { toast('IBKR import: ' + e.message, 'error', 9000); }
  }
  // What the transaction list would be after this import with the chosen options.
  function resultOf(pending, opts) {
    const remove = new Set([...pending.plan.removeIds, ...opts.nearIds, ...(opts.master ? pending.plan.manualIds : [])]);
    return { remove, list: stRef.current.lots.filter((t) => !remove.has(t.id)).concat(pending.plan.add) };
  }
  async function confirmIbkr(opts) {
    const pending = stRef.current.pending;
    try {
      const { remove, list } = resultOf(pending, opts);
      const { next } = await withRates(list);
      if (next.some((t) => txType(t) !== 'fx' && !((t.fxAtBuy ?? t.fx) > 0))) throw new Error('Missing exchange rate for some dates');
      await db.kvSet('undo', { at: Date.now(), label: pending.fileName, lots: stRef.current.lots });
      await db.replaceLots(next);
      const check = checkPositions(next, pending.positions);
      const meta = { ...stRef.current.meta, lastCheck: check, lastImport: Date.now() };
      await db.kvSet('meta', meta);
      await reload();
      patch({ pending: null, meta, undo: { at: Date.now(), label: pending.fileName } });
      toast(`Imported ${pending.plan.add.length} transactions${remove.size ? ` · replaced ${remove.size} hand-entered` : ''}`, '', 6000);
      leaveTo('#holdings');
      refresh(true);
    } catch (e) { toast('Import failed: ' + e.message + ' (needs internet for exchange rates)', 'error', 9000); }
  }
  async function undoImport() {
    const u = await db.kvGet('undo');
    if (!u) return toast('Nothing to undo');
    await db.replaceLots(u.lots);
    await db.kvDel('undo');
    const meta = { ...stRef.current.meta, lastCheck: null };
    await db.kvSet('meta', meta);
    await reload();
    patch({ undo: null, meta });
    toast('Import undone — back to how it was before');
  }
  async function recalcRates() {
    try {
      const { next, changed } = await withRates(stRef.current.lots, true);
      await db.replaceLots(next);
      await reload();
      toast(`Updated the rate on ${changed} transactions`, '', 5000);
    } catch (e) { toast('Couldn’t update rates: ' + e.message, 'error', 8000); }
  }
  async function deleteAll() {
    await db.kvSet('undo', { at: Date.now(), label: 'Delete all', lots: stRef.current.lots });
    patch({ undo: { at: Date.now(), label: 'Delete all' } });
    await db.replaceLots([]);
    await reload();
    toast('All transactions deleted');
  }

  const formType = route.form ? (route.form.isNew ? route.form.type : txType(state.lots.find((t) => t.id === route.form.id) || {})) : null;
  const title = route.form ? (route.form.isNew ? 'New transaction' : 'Edit ' + TYPE_LABEL[formType]?.toLowerCase())
    : route.page === 'import' ? 'Import from IBKR' : route.page === 'conversions' ? 'Conversions'
    : route.ticker ? route.ticker : { home: 'Portfolio', holdings: 'Holdings', charts: 'Charts', settings: 'Settings' }[route.tab];
  const sub = route.form || route.ticker || route.page;
  let body;
  if (route.form) body = html`<${TxForm} key=${location.hash} route=${route} txns=${state.lots} pf=${pf} settings=${state.settings} onSave=${saveTx} onDelete=${deleteTx}/>`;
  else if (route.page === 'import') body = html`<${ImportPreview} pending=${state.pending} resultOf=${resultOf} onConfirm=${confirmIbkr} onCancel=${() => { patch({ pending: null }); back('settings'); }}/>`;
  else if (route.page === 'conversions') body = html`<${Conversions} txns=${state.lots}/>`;
  else if (route.ticker) body = html`<${Detail} ticker=${route.ticker} pf=${pf} ccy=${ccy} quotes=${state.quotes} closes=${hist.closes?.[route.ticker]} txns=${state.lots} range=${pRange} setRange=${setPRange}/>`;
  else if (route.tab === 'charts') body = html`<${Charts} data=${histData} ccy=${ccy} hist=${hist} noKey=${!state.settings.twelveKey} onRetry=${() => ensureHistory(true)} range=${range} setRange=${setRange}/>`;
  else if (route.tab === 'holdings') body = html`<${Holdings} pf=${pf} ccy=${ccy} sort=${sort} setSort=${setSort} check=${state.meta.lastCheck}/>`;
  else if (route.tab === 'settings') body = html`<${Settings} state=${view} saveSettings=${saveSettings} onExport=${exportBackup} onImport=${importAny} onIbkr=${importAny} onRefresh=${refresh} onDeleteAll=${deleteAll} onRecalc=${recalcRates} onUndo=${undoImport} onLock=${setLock} toast=${toast}/>`;
  else body = html`<${Home} pf=${pf} ccy=${ccy} setCcy=${(v) => saveSettings({ ccy: v })} state=${view} onExport=${exportBackup} onImport=${importAny} onIbkr=${importAny} onUndo=${undoImport}/>`;

  const showEye = !route.form && route.tab !== 'settings';
  return html`
    <div class="pull" style=${`height:${pull}px;opacity:${pull / 70}`}><span class=${pull > 70 ? 'ready' : ''}><${Icon} d=${I.refresh} size=${20}/></span></div>
    <header class="top">
      ${sub ? html`<button class="icon" aria-label="Back" onClick=${() => back(route.page ? 'settings' : 'holdings')}><${Icon} d=${I.back}/></button>`
        : showEye ? html`<button class="icon" aria-label=${HIDE ? 'Show amounts' : 'Hide amounts'} aria-pressed=${HIDE} onClick=${() => saveSettings({ hide: !HIDE })}><${Icon} d=${HIDE ? I.eyeOff : I.eye}/></button>`
        : html`<span class="icon-space"></span>`}
      <h1>${title}</h1>
      ${!route.form && !route.page ? html`<button class=${'icon ' + (state.loading ? 'spin' : '')} aria-label="Refresh prices" onClick=${() => refresh(true)}><${Icon} d=${I.refresh}/></button>` : html`<span class="icon-space"></span>`}
    </header>
    ${newVersion && html`<button class="update" onClick=${applyUpdate}>New version ${newVersion} — tap to update</button>`}
    <main>${body}</main>
    ${!route.form && !route.page && route.tab !== 'settings' && route.tab !== 'charts' && state.lots.length > 0 && html`<button class="fab" aria-label="Add a transaction" onClick=${() => go('#tx/new/buy/' + (route.ticker || ''))}><${Icon} d=${I.plus} size=${26}/></button>`}
    <nav class="tabs">
      ${[['home', 'Home', I.home], ['holdings', 'Holdings', I.list], ['charts', 'Charts', I.chart], ['settings', 'Settings', I.gear]].map(([k, t, d]) => html`
        <button class=${route.tab === k && !sub ? 'on' : route.tab === k ? 'half' : ''} aria-current=${route.tab === k ? 'page' : null} onClick=${() => goTab(k)}><${Icon} d=${d}/><span>${t}</span></button>`)}
    </nav>
    <${Toast} toast=${toastMsg} onClose=${() => setToastMsg(null)}/>`;
}

history.replaceState('root', '', location.hash || '#home');
render(html`<${App}/>`, document.getElementById('app'));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || new URLSearchParams(location.search).has('sw'))) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
