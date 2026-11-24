/* 依存なしの折れ線チャート（SVG）。全系列は同じ日付軸を共有する。 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  function niceTicks(min, max, n) {
    if (min === max) { min = min * 0.95; max = max * 1.05 || 1; }
    const span = max - min, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(v);
    return out;
  }
  /**
   * opt = { dates:[...], series:[{name, color, values:[...], area, dash}], ref:{value,label},
   *         fmtAxis(v), fmtTip(v), height, zeroBase }
   */
  function lineChart(host, opt) {
    host.innerHTML = '';
    host.classList.add('chart');
    let dates = opt.dates, series = opt.series;
    const n0 = dates.length;
    if (n0 < 2) { host.innerHTML = '<div class="empty-chart">表示できる履歴がまだありません</div>'; return; }
    const step = Math.ceil(n0 / 400); // 間引き（最終点は必ず残す）
    if (step > 1) {
      const keep = [];
      for (let i = 0; i < n0; i++) if (i % step === 0 || i === n0 - 1) keep.push(i);
      dates = keep.map((i) => dates[i]);
      series = series.map((s) => Object.assign({}, s, { values: keep.map((i) => s.values[i]) }));
    }
    const n = dates.length;
    const W = Math.max(240, host.clientWidth || 320), H = opt.height || 190;
    const m = { t: 14, r: 4, b: 20, l: 4 };
    let lo = Infinity, hi = -Infinity;
    series.forEach((s) => s.values.forEach((v) => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }));
    if (opt.ref && opt.ref.value != null) { lo = Math.min(lo, opt.ref.value); hi = Math.max(hi, opt.ref.value); }
    if (opt.zeroBase) lo = Math.min(lo, 0);
    const padY = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
    if (!opt.zeroBase || lo < 0) lo -= padY;
    hi += padY;
    const x = (i) => m.l + (i / (n - 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': opt.label || 'チャート' }, host);
    niceTicks(lo, hi, 4).forEach((v) => {
      el('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, svg);
    });
    const short = (d) => d.slice(0, 4) + '/' + (+d.slice(5, 7)) + '/' + (+d.slice(8, 10));
    el('text', { class: 'axis', x: m.l, y: H - 5 }, svg).textContent = short(dates[0]);
    el('text', { class: 'axis', x: W - m.r, y: H - 5, 'text-anchor': 'end' }, svg).textContent = short(dates[n - 1]);
    if (opt.ref && opt.ref.value != null) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(opt.ref.value), y2: y(opt.ref.value), stroke: 'var(--ref)', 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }, svg);
    }
    series.forEach((s) => {
      let d = '', started = false, first = -1, last = -1;
      s.values.forEach((v, i) => {
        if (v == null) return;
        d += (started ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1);
        if (!started) first = i;
        started = true; last = i;
      });
      if (!started) return;
      if (s.area) el('path', { d: d + `L${x(last).toFixed(1)} ${y(lo)}L${x(first).toFixed(1)} ${y(lo)}Z`, fill: s.color, opacity: 0.1 }, svg);
      const p = el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      if (s.dash) p.setAttribute('stroke-dasharray', '5 4');
    });
    // 目盛ラベルは系列の上に描く（線と重なっても読めるよう面色の縁取り付き）
    niceTicks(lo, hi, 4).forEach((v) => { el('text', { class: 'axis halo', x: m.l, y: y(v) - 3 }, svg).textContent = opt.fmtAxis(v); });
    // ホバー／タッチ：十字線＋ツールチップ
    const cross = el('line', { y1: m.t, y2: H - m.b, stroke: 'var(--text3)', 'stroke-width': 1, visibility: 'hidden' }, svg);
    const dots = series.map((s) => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    const tip = document.createElement('div');
    tip.className = 'tip';
    host.appendChild(tip);
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function show(clientX) {
      const r = svg.getBoundingClientRect();
      const px = (clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      let html = '<b>' + short(dates[i]) + '</b>';
      series.forEach((s, k) => {
        const v = s.values[i];
        if (v == null) { dots[k].setAttribute('visibility', 'hidden'); return; }
        dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); dots[k].setAttribute('visibility', 'visible');
        html += `<br><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(opt.fmtTip(v))}</b>`;
      });
      if (opt.tipExtra) html += opt.tipExtra(i, series.map((s) => s.values[i]));
      tip.innerHTML = html;
      tip.style.display = 'block';
      const tw = tip.offsetWidth, cx = (x(i) / W) * r.width;
      tip.style.left = Math.max(0, Math.min(r.width - tw, cx < r.width / 2 ? cx + 10 : cx - tw - 10)) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.style.display = 'none'; }
    svg.addEventListener('pointermove', (e) => show(e.clientX));
    svg.addEventListener('pointerdown', (e) => show(e.clientX));
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointercancel', hide);
  }
  root.Chart = { lineChart };
})(self);
