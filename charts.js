import { html, useState, useEffect, useRef } from './preact-htm.mjs';

// Lightweight responsive SVG line chart with a crosshair + tooltip (touch and mouse).
// series: [{label, values:[number|null], color:'var(--s1)', dash?:true, width?:2}]

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const e = raw / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toPrecision(12));
  return out;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dLabel = (iso, short) => { const [y, m, d] = iso.split('-'); return short ? `${+d} ${MON[+m - 1]}` : `${MON[+m - 1]} ${y.slice(2)}`; };
const dFull = (iso) => { const [y, m, d] = iso.split('-'); return `${+d} ${MON[+m - 1]} ${y}`; };

export function LineChart({ dates, series, fmt, axisFmt, height = 210, markers = [], zero = false, label = 'Chart' }) {
  const wrap = useRef();
  const [w, setW] = useState(340);
  const [hi, setHi] = useState(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setW(el.clientWidth || 340);
    const ro = new ResizeObserver(() => setW(el.clientWidth || 340));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = dates.length;
  if (n < 2) return html`<div class="chart-empty muted small">Not enough history yet.</div>`;
  const padL = 52, padR = 10, padT = 8, padB = 24;
  const iw = Math.max(50, w - padL - padR), ih = height - padT - padB;
  const all = series.flatMap((s) => s.values).filter((v) => v != null && isFinite(v));
  let lo = Math.min(...all), top = Math.max(...all);
  if (zero) { lo = Math.min(lo, 0); top = Math.max(top, 0); }
  const span = top - lo || Math.abs(top) || 1;
  lo -= span * 0.06; top += span * 0.06;
  const ticks = niceTicks(lo, top);
  const X = (i) => padL + (i / (n - 1)) * iw;
  const Y = (v) => padT + (1 - (v - lo) / (top - lo)) * ih;
  const path = (vals) => {
    let d = '', on = false;
    vals.forEach((v, i) => {
      if (v == null || !isFinite(v)) { on = false; return; }
      d += `${on ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; on = true;
    });
    return d;
  };
  const days = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / 864e5;
  const xt = [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - padL) / iw) * (n - 1));
    setHi(Math.max(0, Math.min(n - 1, i)));
  };
  const tipLeft = hi == null ? 0 : Math.min(Math.max(X(hi) - 80, 0), w - 168);
  const first = series[0];
  return html`<div class="chart" ref=${wrap}>
    ${series.length > 1 && html`<div class="legend">${series.map((s) => html`<span><i class=${'key' + (s.dash ? ' dash' : '')} style=${`--c:${s.color}`}></i>${s.label}</span>`)}</div>`}
    <svg width=${w} height=${height} role="img" aria-label=${label} style="touch-action: pan-y"
      onPointerDown=${pick} onPointerMove=${pick} onPointerLeave=${() => setHi(null)} onPointerCancel=${() => setHi(null)}>
      ${ticks.map((t) => html`<g><line x1=${padL} x2=${padL + iw} y1=${Y(t)} y2=${Y(t)} class=${t === 0 && zero ? 'zero' : 'grid'}/>
        <text x=${padL - 6} y=${Y(t) + 4} text-anchor="end" class="tick">${(axisFmt || fmt)(t)}</text></g>`)}
      ${[...new Set(xt)].map((i, k) => html`<text x=${X(i)} y=${height - 6} text-anchor=${k === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} class="tick">${dLabel(dates[i], days < 75)}</text>`)}
      ${series.map((s) => html`<path d=${path(s.values)} fill="none" stroke=${s.color} stroke-width=${s.width || 2} stroke-dasharray=${s.dash ? '5 4' : null} stroke-linejoin="round" stroke-linecap="round"/>`)}
      ${markers.map((m) => first.values[m.i] != null && html`<circle cx=${X(m.i)} cy=${Y(first.values[m.i])} r="5" class=${'mk ' + m.kind}><title>${m.title}</title></circle>`)}
      ${hi != null && html`<g class="cross"><line x1=${X(hi)} x2=${X(hi)} y1=${padT} y2=${padT + ih}/>
        ${series.map((s) => s.values[hi] != null && html`<circle cx=${X(hi)} cy=${Y(s.values[hi])} r="4" fill=${s.color} class="dot"/>`)}</g>`}
    </svg>
    ${hi != null && html`<div class="tip" style=${`left:${tipLeft}px`}>
      <div class="tip-date">${dFull(dates[hi])}</div>
      ${series.map((s) => html`<div class="tip-row"><i class=${'key' + (s.dash ? ' dash' : '')} style=${`--c:${s.color}`}></i><b>${s.values[hi] == null ? '—' : fmt(s.values[hi])}</b><span>${s.label}</span></div>`)}
      ${markers.filter((m) => m.i === hi).map((m) => html`<div class="tip-row small">${m.title}</div>`)}
    </div>`}
    <details class="table-view small"><summary>Show as table</summary>
      <table><thead><tr><th>Date</th>${series.map((s) => html`<th>${s.label}</th>`)}</tr></thead>
        <tbody>${monthEnds(dates).map((i) => html`<tr><td>${dFull(dates[i])}</td>${series.map((s) => html`<td>${s.values[i] == null ? '—' : fmt(s.values[i])}</td>`)}</tr>`)}</tbody></table>
    </details>
  </div>`;
}

// Last index of each month (plus the final point) — for the table view.
function monthEnds(dates) {
  const out = [];
  dates.forEach((d, i) => { if (i === dates.length - 1 || dates[i + 1].slice(0, 7) !== d.slice(0, 7)) out.push(i); });
  return out.reverse();
}
