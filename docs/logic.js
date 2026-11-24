/* 計算ロジック（純関数・DOM非依存）。ブラウザでは window.Logic、Node では module.exports。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PER = { fund: 10000, us: 1 }; // 投信の単価は1万口あたり
  const DAY = 86400000;

  const toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (s, n) => fromMs(toMs(s) + n * DAY);
  const pad = (n) => String(n).padStart(2, '0');
  function localToday(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // rows = [[date, close], ...] 昇順
  function idxOnOrBefore(rows, date) {
    let lo = 0, hi = rows.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid][0] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function idxOnOrAfter(rows, date) {
    const i = idxOnOrBefore(rows, date);
    if (i >= 0 && rows[i][0] === date) return i;
    return i + 1 < rows.length ? i + 1 : -1;
  }
  function closeOn(rows, date) {
    if (!rows) return null;
    const i = idxOnOrBefore(rows, date);
    return i < 0 ? null : rows[i][1];
  }

  // ctx = { prices: {symbol: {rows}}, fx: rows(USDJPY), today }
  const rowsOf = (ctx, symbol) => (ctx.prices[symbol] && ctx.prices[symbol].rows) || null;

  /** 1単位（投信=1口・米国株=1株）あたりの円評価額 */
  function unitJpy(ctx, asset, date) {
    const p = closeOn(rowsOf(ctx, asset.symbol), date);
    if (p == null) return null;
    if (asset.type === 'us') {
      const f = closeOn(ctx.fx, date);
      return f == null ? null : p * f;
    }
    return p / PER.fund;
  }

  /** スポット購入 → イベント1件（解決不能なら unresolved） */
  function expandLot(ctx, asset, lot) {
    const base = { entryId: lot.id, src: 'lot', symbol: lot.symbol, account: lot.account, date: lot.date, execDate: lot.date };
    let est = false;
    let price = lot.price;
    if (price == null) { price = closeOn(rowsOf(ctx, lot.symbol), lot.date); est = true; }
    if (price == null) return [Object.assign(base, { unresolved: true, reason: '購入日の価格がない' })];
    let unit = price / PER[asset.type]; // 現地通貨建て1単位
    let fx = 1;
    if (asset.type === 'us') {
      fx = lot.fx;
      if (fx == null) { fx = closeOn(ctx.fx, lot.date); est = true; }
      if (fx == null) return [Object.assign(base, { unresolved: true, reason: '購入日の為替がない' })];
    }
    let units, cost;
    if (lot.qty != null) { units = lot.qty; cost = units * unit * fx; }
    else { cost = lot.amount; units = cost / (unit * fx); }
    return [Object.assign(base, { units, cost, costNative: cost / fx, est })];
  }

  /** 毎月積立 → 月次イベント列。約定日は「引落日以降の最初の営業日＋lag営業日」の価格 */
  function expandPlan(ctx, asset, plan) {
    const rows = rowsOf(ctx, plan.symbol);
    const out = [];
    const curYm = ctx.today.slice(0, 7);
    const endYm = plan.end && plan.end < curYm ? plan.end : curYm;
    let y = +plan.start.slice(0, 4), m = +plan.start.slice(5, 7);
    for (let guard = 0; guard < 1200; guard++) {
      const ym = y + '-' + pad(m);
      if (ym > endYm) break;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const cd = ym + '-' + pad(Math.min(plan.day || 1, lastDay));
      if (cd > ctx.today) break;
      const ev = { entryId: plan.id, src: 'plan', symbol: plan.symbol, account: plan.account, date: cd };
      let i = rows ? idxOnOrAfter(rows, cd) : -1;
      if (i >= 0) i += plan.lag || 0;
      if (!rows || i < 0 || i >= rows.length) {
        out.push(Object.assign(ev, { pending: true, cost: plan.amount }));
      } else {
        const execDate = rows[i][0];
        const fx = asset.type === 'us' ? closeOn(ctx.fx, execDate) : 1;
        if (fx == null) out.push(Object.assign(ev, { pending: true, cost: plan.amount }));
        else {
          const unit = (rows[i][1] / PER[asset.type]) * fx;
          const net = plan.amount - (plan.fee || 0);
          out.push(Object.assign(ev, { execDate, units: net / unit, cost: plan.amount, costNative: plan.amount / fx, est: true }));
        }
      }
      if (++m > 12) { m = 1; y++; }
    }
    // 証券口座の実際の保有口数で補正（推定口数を比例配分）
    if (plan.unitsNow != null) {
      const sum = out.reduce((s, e) => s + (e.pending ? 0 : e.units), 0);
      if (sum > 0) { const k = plan.unitsNow / sum; out.forEach((e) => { if (!e.pending) { e.units *= k; e.est = false; } }); }
    }
    return out;
  }

  /** 全エントリ → イベント列 */
  function expandAll(ctx, assets, entries) {
    let ev = [];
    for (const e of entries) {
      const a = assets[e.symbol];
      if (!a) continue;
      ev = ev.concat(e.kind === 'plan' ? expandPlan(ctx, a, e) : expandLot(ctx, a, e));
    }
    return ev;
  }
  const live = (ev) => ev.filter((e) => !e.pending && !e.unresolved);

  /** XIRR（年率・二分法）。flows=[{date, amount}] 出金は負。解なしは null */
  function xirr(flows) {
    if (flows.length < 2) return null;
    const t0 = Math.min.apply(null, flows.map((f) => toMs(f.date)));
    const cf = flows.map((f) => [(toMs(f.date) - t0) / DAY / 365, f.amount]);
    const npv = (r) => cf.reduce((s, c) => s + c[1] / Math.pow(1 + r, c[0]), 0);
    let lo = -0.9999, hi = 1000;
    let flo = npv(lo), fhi = npv(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, fm = npv(mid);
      if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
      if (hi - lo < 1e-9) break;
    }
    return (lo + hi) / 2;
  }

  /** イベント集合の集計（評価額・損益・IRR・前日比） */
  function summarize(ctx, assets, events, minIrrDays) {
    const ev = live(events);
    const bySym = {};
    let cost = 0, value = 0, prev = 0, missing = false, first = null;
    for (const e of ev) {
      (bySym[e.symbol] = bySym[e.symbol] || { units: 0 }).units += e.units;
      cost += e.cost;
      if (!first || e.date < first) first = e.date;
    }
    for (const sym in bySym) {
      const a = assets[sym], rows = rowsOf(ctx, sym);
      const u = unitJpy(ctx, a, ctx.today);
      if (u == null) { missing = true; continue; }
      value += bySym[sym].units * u;
      const i = idxOnOrBefore(rows, ctx.today);
      const pu = i > 0 ? unitJpy(ctx, a, rows[i - 1][0]) : null;
      prev += bySym[sym].units * (pu == null ? u : pu);
    }
    const flows = ev.map((e) => ({ date: e.date, amount: -e.cost }));
    flows.push({ date: ctx.today, amount: value });
    const days = first ? (toMs(ctx.today) - toMs(first)) / DAY : 0;
    const irr = !missing && cost > 0 && days >= (minIrrDays == null ? 30 : minIrrDays) ? xirr(flows) : null;
    const units = Object.keys(bySym).length === 1 ? bySym[Object.keys(bySym)[0]].units : null;
    return {
      units, cost, value, pnl: value - cost, pct: cost > 0 ? (value - cost) / cost : null, irr,
      dayChange: value - prev, dayPct: prev > 0 ? (value - prev) / prev : null,
      first, days, missing, costNative: ev.reduce((s, e) => s + e.costNative, 0),
      pendingCost: events.filter((e) => e.pending).reduce((s, e) => s + e.cost, 0),
      unresolved: events.filter((e) => e.unresolved).length,
    };
  }

  /** 評価額・投資元本の日次推移（平日）。[{date, value, cost}] */
  function series(ctx, assets, events) {
    const ev = live(events).slice().sort((a, b) => (a.execDate < b.execDate ? -1 : 1));
    if (!ev.length) return [];
    const out = [];
    const units = {};
    let cost = 0, k = 0;
    const end = toMs(ctx.today);
    for (let t = toMs(ev[0].execDate); t <= end; t += DAY) {
      const dow = new Date(t).getUTCDay();
      const d = fromMs(t);
      while (k < ev.length && ev[k].execDate <= d) { units[ev[k].symbol] = (units[ev[k].symbol] || 0) + ev[k].units; cost += ev[k].cost; k++; }
      if ((dow === 0 || dow === 6) && t !== end) continue;
      let v = 0;
      for (const sym in units) { const u = unitJpy(ctx, assets[sym], d); if (u != null) v += units[sym] * u; }
      out.push({ date: d, value: v, cost });
    }
    return out;
  }

  return { PER, toMs, fromMs, addDays, localToday, idxOnOrBefore, idxOnOrAfter, closeOn, unitJpy,
    expandLot, expandPlan, expandAll, live, xirr, summarize, series };
});
