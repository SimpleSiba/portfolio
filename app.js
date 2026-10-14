import { html, render, useState, useEffect, useMemo, useRef } from './preact-htm.mjs';
import * as db from './db.js';
import * as api from './api.js';
import { portfolio, isStale, todayISO, txType, avgConversionRate } from './calc.js';
import { parseIbkr, planImport } from './ibkr.js';

const VERSION = '1.2.0';
const DEFAULT_SETTINGS = { finnhubKey: '', twelveKey: '', ccy: 'ILS', hide: false, rateMode: 'official' };
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
const ACCEPT_BACKUP = 'application/json,.json,text/plain,.txt';
const ACCEPT_CSV = '.csv,text/csv,text/comma-separated-values,application/vnd.ms-excel,text/plain';

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

function Home({ pf, ccy, setCcy, state, onExport, onImport, onIbkr }) {
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
      ${extra && html`<div class="sub small muted breakdown">
        <span>Open <span class=${tone(total['pl' + C])}>${fmtSigned(total['pl' + C], ccy)}</span></span>
        <span>Realised <span class=${tone(total['realized' + C])}>${fmtSigned(total['realized' + C], ccy)}</span></span>
        <span>Dividends <span class=${tone(total['div' + C])}>${fmtSigned(total['div' + C], ccy)}</span></span></div>`}
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
    ${needBackup && html`<div class="banner">
      <span>${state.meta.lastExport ? 'Last backup over 30 days ago.' : 'No backup yet.'} Your data lives only on this phone.</span>
      <button class="btn small" onClick=${() => onExport('download')}>Back up</button>
    </div>`}
  </section>`;
}

const SORTS = { value: 'Value', pl: 'P/L', ret: 'Return', day: 'Today' };
function Holdings({ pf, ccy, sort, setSort }) {
  if (!pf.holdings.length) return html`<section><div class="card placeholder"><p>No investments yet.</p><button class="btn primary" onClick=${() => go('#tx/new/buy')}>Add your first buy</button></div></section>`;
  const C = ccy === 'ILS' ? 'Ils' : 'Usd';
  const key = { value: (h) => h['value' + C] ?? -Infinity, pl: (h) => h['totalPl' + C] ?? -Infinity, ret: (h) => h['totalRet' + C] ?? -Infinity, day: (h) => h.dayPct ?? -Infinity }[sort];
  const open = pf.holdings.filter((h) => !h.closed).sort((a, b) => key(b) - key(a));
  const closed = pf.holdings.filter((h) => h.closed).sort((a, b) => (b['totalPl' + C] ?? 0) - (a['totalPl' + C] ?? 0));
  const n = pf.holdings.reduce((a, h) => a + h.buys.length + h.sells.length + h.divs.length, 0);
  return html`<section>
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

function Detail({ ticker, pf, ccy, quotes }) {
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
  stats.push(['Total P/L', S(h['totalPl' + C])], ['Total return', html`<span class=${tone(h['totalRet' + C])}>${fmtPct(h['totalRet' + C])}</span>`]);
  if (!h.closed) stats.push(['Weight', fmtPct(h.weight, 1).replace('+', '')], ['Today', S(h['day' + C])]);
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
    <div class="card placeholder muted small">Price chart since first buy — coming in v2</div>
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

// One form for buys, sells, dividends and currency conversions.
function TxForm({ route, txns, pf, settings, onSave, onDelete }) {
  const existing = route.form.id ? txns.find((l) => l.id === route.form.id) : null;
  const [type, setType] = useState(existing ? txType(existing) : route.form.type || 'buy');
  const S = (v) => (v == null ? '' : String(v));
  const [f, setF] = useState(() => existing
    ? { ticker: existing.ticker || '', date: existing.date, shares: S(existing.shares), priceUsd: S(existing.priceUsd), feesUsd: S(existing.feesUsd || 0),
        rate: S(existing.fxAtBuy ?? existing.fx), grossUsd: S(existing.grossUsd), taxUsd: S(existing.taxUsd), ils: S(existing.ils), usd: S(existing.usd), note: existing.note || '' }
    : { ticker: route.form.ticker || '', date: todayISO(), shares: '', priceUsd: '', feesUsd: '0', rate: '', grossUsd: '', taxUsd: '', ils: '', usd: '', note: '' });
  const convAvailable = (d) => avgConversionRate(txns.filter((t) => t.id !== existing?.id), d) != null;
  // Existing entries keep their stored rate unless the user picks a source again.
  const [mode, setMode] = useState(() => (existing ? existing.fxMode || 'manual' : settings.rateMode === 'conv' ? 'conv' : 'official'));
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
    api.fxUsdIls(f.date >= todayISO() ? 'latest' : f.date)
      .then((r) => live && setOfficial(r.rate)).catch(() => live && setOfficial(null)).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [f.date, type]);

  const conv = avgConversionRate(txns.filter((t) => t.id !== existing?.id), f.date);
  const autoRate = type === 'buy' && mode === 'conv' ? conv : official;
  useEffect(() => { if (mode !== 'manual' && autoRate) setF((o) => ({ ...o, rate: String(+autoRate.toFixed(6)) })); }, [autoRate, mode]);
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
  const rateHint = mode === 'manual' ? 'Your rate'
    : busy && !(type === 'buy' && mode === 'conv') ? 'Fetching rate…'
    : type === 'buy' && mode === 'conv' ? (conv ? 'Your average conversion rate up to this date' : 'No conversions logged before this date')
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
      <p class="small muted">Log each time you converted shekels to dollars (e.g. in IBKR). Your buys can then use your real average rate.</p>
      <div class="two">
        <label>Shekels paid (ILS) <${Err} k="ils"/><input inputmode="decimal" value=${f.ils} onInput=${set('ils')} placeholder="10000"/></label>
        <label>Dollars received (USD) <${Err} k="usd"/><input inputmode="decimal" value=${f.usd} onInput=${set('usd')} placeholder="3270"/></label>
      </div>`}
    ${type !== 'fx' && html`<label>${rateLabel} <${Err} k="rate"/>
      ${type === 'buy' && html`<${Segmented} label="Rate source" value=${mode} onChange=${setMode}
        options=${[['official', 'Official'], ['conv', 'My conversions', !convAvailable(f.date)], ['manual', 'Custom']]}/>`}
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

function ImportPreview({ pending, onConfirm, onCancel }) {
  if (!pending) return html`<section><p class="muted">Nothing to import. Pick a file in Settings.</p></section>`;
  const { plan, skipped, format, fileName } = pending;
  const c = plan.counts;
  const total = plan.add.length;
  return html`<section>
    <div class="card">
      <p class="small muted">${fileName} · ${format}</p>
      ${total === 0 ? html`<p><b>Nothing new.</b> All ${plan.duplicates} transactions in this file are already in the app.</p>` : html`
        <ul class="plain">
          ${c.buy > 0 && html`<li>${plural(c.buy, 'buy', 'buys')}</li>`}
          ${c.sell > 0 && html`<li>${plural(c.sell, 'sell', 'sells')}</li>`}
          ${c.div > 0 && html`<li>${plural(c.div, 'dividend', 'dividends')} (with US tax withheld)</li>`}
          ${c.fx > 0 && html`<li>${plural(c.fx, 'currency conversion', 'currency conversions')} (USD.ILS)</li>`}
        </ul>
        ${plan.removeIds.length > 0 && html`<p class="small">${plan.removeIds.length} buys you entered by hand match IBKR trades (same stock, day and shares) and will be <b>replaced</b> by the exact IBKR versions.</p>`}
        ${plan.duplicates > 0 && html`<p class="small muted">${plan.duplicates} already imported earlier — skipped.</p>`}`}
      ${skipped.length > 0 && html`<details class="small"><summary>${plural(skipped.length, 'row', 'rows')} not imported</summary><ul>${skipped.map((s) => html`<li>${s}</li>`)}</ul></details>`}
      <p class="small muted">Exchange rates: buys use your “Cost rate” setting; sells and dividends use the official rate of their date.</p>
    </div>
    <button class="btn wide primary" disabled=${total === 0 && plan.removeIds.length === 0} onClick=${onConfirm}>Import ${plural(total, 'transaction', 'transactions')}</button>
    <button class="btn wide ghost" onClick=${onCancel}>Cancel</button>
  </section>`;
}

function Conversions({ txns }) {
  const list = txns.filter((t) => txType(t) === 'fx').sort((a, b) => b.date.localeCompare(a.date));
  const avg = avgConversionRate(txns);
  return html`<section>
    <div class="card row-between"><span>Average rate</span><b class="num">${avg ? '₪' + avg.toFixed(4) + ' per $' : '—'}</b></div>
    <div class="card list">
      ${list.length === 0 && html`<p class="muted small" style="padding:14px 16px">No conversions yet.</p>`}
      ${list.map((t) => html`<button class="hrow" onClick=${() => go('#tx/' + encodeURIComponent(t.id))}>
        <div class="l"><div>${fmtDate(t.date)}${t.source === 'ibkr' ? html` <span class="muted small">· IBKR</span>` : ''}</div>
          <div class="muted small">${fmtMoney(t.ils, 'ILS', 2)} → ${fmtMoney(t.usd, 'USD', 2)}</div></div>
        <div class="r num">₪${(t.ils / t.usd).toFixed(4)}</div>
        <span class="muted"><${Icon} d=${I.chev} size=${18}/></span>
      </button>`)}
    </div>
    <button class="btn wide" onClick=${() => go('#tx/new/fx')}>Add a conversion</button>
  </section>`;
}

function Settings({ state, saveSettings, onExport, onImport, onIbkr, onRefresh, onDeleteAll, onRecalc, toast }) {
  const s = state.settings;
  const [keys, setKeys] = useState({ finnhubKey: s.finnhubKey, twelveKey: s.twelveKey });
  const [show, setShow] = useState(false);
  const [test, setTest] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const dirty = keys.finnhubKey !== s.finnhubKey || keys.twelveKey !== s.twelveKey;
  const nConv = state.lots.filter((t) => txType(t) === 'fx').length;
  const avg = avgConversionRate(state.lots);

  async function runTest() {
    setTest({ busy: true });
    const res = {};
    const t = async (name, fn) => { try { res[name] = { ok: true, text: await fn() }; } catch (e) { res[name] = { ok: false, text: e.message }; } };
    await Promise.all([
      keys.finnhubKey ? t('Finnhub', async () => `SPY ${price((await api.finnhubQuote('SPY', keys.finnhubKey.trim())).price)}`) : (res.Finnhub = { ok: false, text: 'No key' }),
      keys.twelveKey ? t('Twelve Data', async () => `SPY ${price((await api.twelveQuote('SPY', keys.twelveKey.trim())).price)}`) : (res['Twelve Data'] = { ok: false, text: 'No key' }),
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

    <h2>Import from Interactive Brokers</h2>
    <div class="card form">
      <ol class="small muted steps-list">
        <li>In IBKR (Client Portal / website): <b>Performance & Reports → Statements → Activity</b>.</li>
        <li>Period: <b>Custom</b>, from your first trade to today. Format: <b>CSV</b>. Run → Download.</li>
        <li>Pick that file below. Re-import any time — already imported trades are skipped.</li>
      </ol>
      <${FilePick} accept=${ACCEPT_CSV} onFile=${onIbkr}>Choose IBKR CSV file<//>
      <p class="small muted">Reads stock buys and sells, USD.ILS conversions, dividends and US tax withheld.</p>
    </div>

    <h2>Currency conversions</h2>
    <div class="card form">
      <div class="row-between"><span>${nConv} conversions${avg ? html` · avg <b>₪${avg.toFixed(4)}</b> per $` : ''}</span>
        <button class="btn small" type="button" onClick=${() => go('#conversions')}>View / add</button></div>
      <div class="row-between"><span>Cost rate for buys</span>
        <${Segmented} label="Cost rate for buys" value=${s.rateMode} onChange=${(v) => saveSettings({ rateMode: v })}
          options=${[['official', 'Official'], ['conv', 'My conversions', !nConv]]}/></div>
      <p class="small muted">${s.rateMode === 'conv'
        ? 'Each buy uses your average conversion rate up to its date (official rate if you had no conversion yet).'
        : 'Each buy uses the official USD/ILS rate of its date.'} Buys where you typed a custom rate are never changed.</p>
      <button class="btn" type="button" onClick=${onRecalc}>Apply to all existing buys</button>
    </div>

    <h2>Display</h2>
    <div class="card form">
      <div class="row-between"><span>Main currency</span>
        <${Segmented} label="Main currency" value=${s.ccy} onChange=${(v) => saveSettings({ ccy: v })} options=${[['ILS', '₪ ILS'], ['USD', '$ USD']]}/></div>
      <div class="row-between"><span>Hide amounts <span class="small muted">(eye button at the top)</span></span>
        <${Segmented} label="Hide amounts" value=${s.hide ? 'on' : 'off'} onChange=${(v) => saveSettings({ hide: v === 'on' })} options=${[['off', 'Show'], ['on', 'Hide']]}/></div>
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
    case 'fx': return t.ils > 0 && t.usd > 0;
    default: return false;
  }
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
  useEffect(() => { window.scrollTo(0, 0); }, [route.tab, route.ticker, !!route.form, route.page]);

  useEffect(() => {
    (async () => {
      let meta = (await db.kvGet('meta')) || {};
      if (!meta.initialized) { meta = { initialized: true, created: Date.now() }; await db.kvSet('meta', meta); }
      const [lots, quotes, fx, settings] = await Promise.all([db.getLots(), db.kvGet('quotes'), db.kvGet('fx'), db.kvGet('settings')]);
      const persisted = await db.persist();
      setState({ lots, quotes: quotes || {}, fx, settings: { ...DEFAULT_SETTINGS, ...settings }, meta, persisted, loading: false, pending: null });
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

  // Official USD/ILS for many dates in one request.
  async function officialRates(dates) {
    const from = dates.reduce((a, d) => (d < a ? d : a), todayISO());
    const start = new Date(Date.parse(from) - 7 * 864e5).toISOString().slice(0, 10); // a week earlier for weekends/holidays
    const series = await api.fxSeries(start);
    return (d) => api.rateOn(series, d);
  }
  function buyRate(t, txns, official) {
    if (stRef.current.settings.rateMode === 'conv') { const c = avgConversionRate(txns, t.date); if (c) return [c, 'conv']; }
    return [official(t.date), 'official'];
  }

  async function saveTx(t) {
    await db.putLot(t);
    await reload();
    toast('Saved');
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
  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
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
  async function pickIbkr(file) {
    try {
      const parsed = parseIbkr(await file.text());
      if (!parsed.txns.length) throw new Error('No stock trades, conversions or dividends found in this file' + (parsed.skipped.length ? ` (${parsed.skipped.length} rows skipped)` : ''));
      const plan = planImport(stRef.current.lots, parsed.txns);
      patch({ pending: { plan, skipped: parsed.skipped, format: parsed.format, fileName: file.name } });
      go('#import');
    } catch (e) { toast('IBKR import: ' + e.message, 'error', 9000); }
  }
  async function confirmIbkr() {
    const { plan } = stRef.current.pending;
    try {
      const remaining = stRef.current.lots.filter((t) => !plan.removeIds.includes(t.id));
      const all = remaining.concat(plan.add);
      const needs = plan.add.filter((t) => t.type !== 'fx').map((t) => t.date);
      const official = needs.length ? await officialRates(needs) : null;
      const add = plan.add.map((t) => {
        if (t.type === 'buy') { const [r, m] = buyRate(t, all, official); return { ...t, fxAtBuy: r, fxMode: m }; }
        if (t.type === 'sell' || t.type === 'div') return { ...t, fx: official(t.date) };
        return t;
      });
      if (add.some((t) => t.type !== 'fx' && !((t.fxAtBuy ?? t.fx) > 0))) throw new Error('Missing exchange rate for some dates');
      await db.replaceLots(remaining.concat(add));
      await reload();
      patch({ pending: null });
      toast(`Imported ${add.length} transactions${plan.removeIds.length ? ` · replaced ${plan.removeIds.length} manual buys` : ''}`, '', 6000);
      leaveTo('#holdings');
      refresh(true);
    } catch (e) { toast('Import failed: ' + e.message + ' (needs internet for exchange rates)', 'error', 9000); }
  }
  async function recalcRates() {
    try {
      const txns = stRef.current.lots;
      const buys = txns.filter((t) => txType(t) === 'buy' && t.fxMode !== 'manual');
      if (!buys.length) return toast('No buys to update');
      const official = await officialRates(buys.map((b) => b.date));
      let changed = 0;
      const next = txns.map((t) => {
        if (txType(t) !== 'buy' || t.fxMode === 'manual') return t;
        const [r, m] = buyRate(t, txns, official);
        if (!(r > 0)) return t;
        if (Math.abs(r - t.fxAtBuy) > 1e-9 || t.fxMode !== m) changed++;
        return { ...t, fxAtBuy: r, fxMode: m };
      });
      await db.replaceLots(next);
      await reload();
      toast(`Updated the rate on ${changed} buys`, '', 5000);
    } catch (e) { toast('Couldn’t update rates: ' + e.message, 'error', 8000); }
  }
  async function deleteAll() {
    await db.replaceLots([]);
    await reload();
    toast('All transactions deleted');
  }

  const formType = route.form ? (route.form.isNew ? route.form.type : txType(state.lots.find((t) => t.id === route.form.id) || {})) : null;
  const title = route.form ? (route.form.isNew ? 'New transaction' : 'Edit ' + TYPE_LABEL[formType]?.toLowerCase())
    : route.page === 'import' ? 'Import from IBKR' : route.page === 'conversions' ? 'Conversions'
    : route.ticker ? route.ticker : { home: 'Portfolio', holdings: 'Holdings', settings: 'Settings' }[route.tab];
  const sub = route.form || route.ticker || route.page;
  let body;
  if (route.form) body = html`<${TxForm} key=${location.hash} route=${route} txns=${state.lots} pf=${pf} settings=${state.settings} onSave=${saveTx} onDelete=${deleteTx}/>`;
  else if (route.page === 'import') body = html`<${ImportPreview} pending=${state.pending} onConfirm=${confirmIbkr} onCancel=${() => { patch({ pending: null }); back('settings'); }}/>`;
  else if (route.page === 'conversions') body = html`<${Conversions} txns=${state.lots}/>`;
  else if (route.ticker) body = html`<${Detail} ticker=${route.ticker} pf=${pf} ccy=${ccy} quotes=${state.quotes}/>`;
  else if (route.tab === 'holdings') body = html`<${Holdings} pf=${pf} ccy=${ccy} sort=${sort} setSort=${setSort}/>`;
  else if (route.tab === 'settings') body = html`<${Settings} state=${view} saveSettings=${saveSettings} onExport=${exportBackup} onImport=${importBackup} onIbkr=${pickIbkr} onRefresh=${refresh} onDeleteAll=${deleteAll} onRecalc=${recalcRates} toast=${toast}/>`;
  else body = html`<${Home} pf=${pf} ccy=${ccy} setCcy=${(v) => saveSettings({ ccy: v })} state=${view} onExport=${exportBackup} onImport=${importBackup} onIbkr=${pickIbkr}/>`;

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
    <main>${body}</main>
    ${!route.form && !route.page && route.tab !== 'settings' && state.lots.length > 0 && html`<button class="fab" aria-label="Add a transaction" onClick=${() => go('#tx/new/buy/' + (route.ticker || ''))}><${Icon} d=${I.plus} size=${26}/></button>`}
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
