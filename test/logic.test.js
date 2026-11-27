const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../docs/logic.js');

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
// 平日のみの価格系列を生成
function mkRows(from, to, fn) {
  const rows = []; let i = 0;
  for (let t = L.toMs(from); t <= L.toMs(to); t += 86400000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) rows.push([L.fromMs(t), fn(i++)]);
  }
  return rows;
}
const assets = { F: { symbol: 'F', type: 'fund' }, U: { symbol: 'U', type: 'us' } };

test('xirr: 1年で+10%は年率10%', () => {
  near(L.xirr([{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 110 }]), 0.10, 1e-6);
});
test('xirr: Excel XIRR の公式例（0.373362535）', () => {
  const r = L.xirr([
    { date: '2008-01-01', amount: -10000 }, { date: '2008-03-01', amount: 2750 },
    { date: '2008-10-30', amount: 4250 }, { date: '2009-02-15', amount: 3250 }, { date: '2009-04-01', amount: 2750 }]);
  near(r, 0.373362535, 1e-6);
});
test('xirr: 符号が変わらなければ null', () => {
  assert.equal(L.xirr([{ date: '2025-01-01', amount: -1 }, { date: '2025-06-01', amount: -1 }]), null);
});
test('closeOn: 休日は直前営業日の値', () => {
  const rows = [['2026-01-05', 1], ['2026-01-06', 2], ['2026-01-09', 3]];
  assert.equal(L.closeOn(rows, '2026-01-08'), 2);
  assert.equal(L.closeOn(rows, '2026-01-04'), null);
  assert.equal(L.idxOnOrAfter(rows, '2026-01-07'), 2);
  assert.equal(L.idxOnOrAfter(rows, '2026-01-10'), -1);
});
test('投信スポット: 口数×基準価額/1万、時価・損益', () => {
  const ctx = { prices: { F: { rows: [['2025-01-06', 10000], ['2026-01-06', 12000]] } }, fx: [], today: '2026-01-06' };
  const ev = L.expandLot(ctx, assets.F, { id: 'a', kind: 'lot', symbol: 'F', account: 'x', date: '2025-01-06', qty: 500000, price: 10000 });
  near(ev[0].cost, 500000);
  const s = L.summarize(ctx, assets, ev);
  near(s.value, 600000); near(s.pnl, 100000); near(s.pct, 0.2); near(s.irr, 0.2, 1e-3);
});
test('投信スポット: 金額入力・単価空欄は当日基準価額で口数を推定', () => {
  const ctx = { prices: { F: { rows: [['2025-01-06', 20000]] } }, fx: [], today: '2025-01-06' };
  const ev = L.expandLot(ctx, assets.F, { id: 'a', symbol: 'F', account: 'x', date: '2025-01-06', amount: 100000 });
  near(ev[0].units, 50000); assert.equal(ev[0].est, true);
});
test('米国株: 取得額は購入時為替、評価額は現在為替', () => {
  const ctx = { prices: { U: { rows: [['2025-01-06', 100], ['2026-01-06', 120]] } }, fx: [['2025-01-06', 150], ['2026-01-06', 160]], today: '2026-01-06' };
  const ev = L.expandLot(ctx, assets.U, { id: 'a', symbol: 'U', account: 'x', date: '2025-01-06', qty: 10, price: 100, fx: 150 });
  near(ev[0].cost, 150000); near(ev[0].costNative, 1000);
  const s = L.summarize(ctx, assets, ev);
  near(s.value, 10 * 120 * 160); near(s.pnl, 42000);
});
test('価格未取得のスポットは unresolved（黙って0円にしない）', () => {
  const ctx = { prices: {}, fx: [], today: '2026-01-06' };
  const ev = L.expandLot(ctx, assets.F, { id: 'a', symbol: 'F', account: 'x', date: '2025-01-06', qty: 1 });
  assert.equal(ev[0].unresolved, true);
  assert.equal(L.summarize(ctx, assets, ev).unresolved, 1);
});
test('積立: 月次展開・休日繰延・約定ラグ・手数料', () => {
  const rows = mkRows('2026-01-01', '2026-03-31', () => 10000);
  const ctx = { prices: { F: { rows } }, fx: [], today: '2026-03-31' };
  // 2026-02-01 は日曜 → 2/2(月) が引落後最初の営業日、lag=1 で 2/3 約定
  const ev = L.expandPlan(ctx, assets.F, { id: 'p', symbol: 'F', account: 'x', amount: 50000, day: 1, start: '2026-01', lag: 1, fee: 0 });
  assert.equal(ev.length, 3);
  assert.equal(ev[1].date, '2026-02-01'); assert.equal(ev[1].execDate, '2026-02-03');
  near(ev[1].units, 50000);
  const ev2 = L.expandPlan(ctx, assets.F, { id: 'p', symbol: 'F', account: 'x', amount: 50000, day: 1, start: '2026-01', lag: 0, fee: 171 });
  near(ev2[0].units, 49829); near(ev2[0].cost, 50000);
});
test('積立: 月末日の丸め・終了年月・約定待ち', () => {
  const rows = mkRows('2026-01-01', '2026-03-20', () => 10000);
  const ctx = { prices: { F: { rows } }, fx: [], today: '2026-03-31' };
  const ev = L.expandPlan(ctx, assets.F, { id: 'p', symbol: 'F', account: 'x', amount: 10000, day: 31, start: '2026-01', lag: 0 });
  assert.deepEqual(ev.map((e) => e.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(ev[2].pending, true); // 価格がまだ無い
  const s = L.summarize(ctx, assets, ev);
  near(s.cost, 20000); near(s.pendingCost, 10000);
  const ev2 = L.expandPlan(ctx, assets.F, { id: 'p', symbol: 'F', account: 'x', amount: 10000, day: 5, start: '2026-01', end: '2026-02', lag: 0 });
  assert.equal(ev2.length, 2);
});
test('積立: 実際の保有口数で補正', () => {
  const rows = mkRows('2026-01-01', '2026-03-31', () => 10000);
  const ctx = { prices: { F: { rows } }, fx: [], today: '2026-03-31' };
  const ev = L.expandPlan(ctx, assets.F, { id: 'p', symbol: 'F', account: 'x', amount: 10000, day: 5, start: '2026-01', lag: 0, unitsNow: 33000 });
  near(ev.reduce((s, e) => s + e.units, 0), 33000);
  near(L.summarize(ctx, assets, ev).value, 33000);
});
test('積立のIRR: 毎月定額・価格が年率約12.7%で上昇 → IRRも同水準', () => {
  const rows = mkRows('2023-01-02', '2026-01-02', (i) => 10000 * Math.pow(1.01, i / 21.75));
  const ctx = { prices: { F: { rows } }, fx: [], today: '2026-01-02' };
  const ev = L.expandPlan(ctx, assets.F, { id: 'p', symbol: 'F', account: 'x', amount: 30000, day: 10, start: '2023-01', lag: 0 });
  const s = L.summarize(ctx, assets, ev);
  const annual = Math.pow(rows[rows.length - 1][1] / rows[0][1], 1 / 3) - 1;
  near(s.irr, annual, 0.01);
});
test('series: 元本は約定日に積み上がり、最終点は summarize と一致', () => {
  const rows = mkRows('2026-01-01', '2026-03-31', (i) => 10000 + i * 10);
  const ctx = { prices: { F: { rows } }, fx: [], today: '2026-03-31' };
  const ev = L.expandPlan(ctx, assets.F, { id: 'p', symbol: 'F', account: 'x', amount: 10000, day: 5, start: '2026-01', lag: 0 });
  const se = L.series(ctx, assets, ev);
  const s = L.summarize(ctx, assets, ev);
  assert.equal(se[0].date, '2026-01-05'); near(se[0].cost, 10000);
  near(se[se.length - 1].value, s.value, 1e-6); near(se[se.length - 1].cost, 30000);
});
test('前日比: 直近2営業日の差', () => {
  const ctx = { prices: { F: { rows: [['2026-01-05', 10000], ['2026-01-06', 10100]] } }, fx: [], today: '2026-01-07' };
  const ev = L.expandLot(ctx, assets.F, { id: 'a', symbol: 'F', account: 'x', date: '2026-01-05', qty: 10000, price: 10000 });
  const s = L.summarize(ctx, assets, ev);
  near(s.dayChange, 100); near(s.dayPct, 0.01);
});

// ---- v1.1.0: ドル建て表示・暗号資産 ----
const assets2 = { F: { symbol: 'F', type: 'fund' }, U: { symbol: 'U', type: 'us' }, C: { symbol: 'C', type: 'crypto' } };
test('ドル建て: 米国株は為替の影響を受けず株価の損益だけになる', () => {
  const ctx = { cur: 'USD', prices: { U: { rows: [['2025-01-06', 100], ['2026-01-06', 120]] } }, fx: [['2025-01-06', 150], ['2026-01-06', 160]], today: '2026-01-06' };
  const ev = L.expandLot(ctx, assets2.U, { id: 'a', symbol: 'U', account: 'x', date: '2025-01-06', qty: 10, price: 100, fx: 150 });
  const s = L.summarize(ctx, assets2, ev);
  near(s.cost, 1000); near(s.value, 1200); near(s.pnl, 200); near(s.irr, 0.2, 1e-3);
});
test('ドル建て: 投信は購入日の為替で元本、現在の為替で評価額を換算（円安なら目減り）', () => {
  const ctx = { cur: 'USD', prices: { F: { rows: [['2025-01-06', 10000], ['2026-01-06', 10000]] } }, fx: [['2025-01-06', 100], ['2026-01-06', 125]], today: '2026-01-06' };
  const ev = L.expandLot(ctx, assets2.F, { id: 'a', symbol: 'F', account: 'x', date: '2025-01-06', qty: 1000000, price: 10000 });
  const s = L.summarize(ctx, assets2, ev);
  near(s.cost, 10000); near(s.value, 8000); near(s.pct, -0.2);
  const yen = L.summarize(Object.assign({}, ctx, { cur: 'JPY' }), assets2, ev);
  near(yen.pnl, 0);
});
test('ドル建て: 積立と series も換算される', () => {
  const rows = mkRows('2026-01-01', '2026-03-31', () => 10000);
  const fx = mkRows('2026-01-01', '2026-03-31', () => 150);
  const ctx = { cur: 'USD', prices: { F: { rows } }, fx, today: '2026-03-31' };
  const ev = L.expandPlan(ctx, assets2.F, { id: 'p', symbol: 'F', account: 'x', amount: 15000, day: 5, start: '2026-01', lag: 0 });
  const s = L.summarize(ctx, assets2, ev);
  near(s.cost, 300); near(s.value, 300);
  const se = L.series(ctx, assets2, ev);
  near(se[se.length - 1].value, 300); near(se[se.length - 1].cost, 300);
});
test('暗号資産: 数量＋円の購入金額で確定、評価はドル価格×為替', () => {
  const ctx = { prices: { C: { rows: [['2025-01-06', 50000], ['2026-01-04', 60000]] } }, fx: [['2025-01-06', 150], ['2026-01-02', 160]], today: '2026-01-04' };
  const ev = L.expandLot(ctx, assets2.C, { id: 'a', symbol: 'C', account: 'x', date: '2025-01-06', qty: 0.1, amount: 800000 });
  near(ev[0].cost, 800000); near(ev[0].units, 0.1); near(ev[0].costUsd, 800000 / 150); assert.equal(ev[0].est, false);
  const s = L.summarize(ctx, assets2, ev);
  near(s.value, 0.1 * 60000 * 160); // 週末は直前の為替
  const usd = L.summarize(Object.assign({}, ctx, { cur: 'USD' }), assets2, ev);
  near(usd.value, 6000); near(usd.cost, 800000 / 150);
});
test('暗号資産: 購入金額が空欄なら当日価格×為替で自動', () => {
  const ctx = { prices: { C: { rows: [['2025-01-06', 50000]] } }, fx: [['2025-01-06', 150]], today: '2025-01-06' };
  const ev = L.expandLot(ctx, assets2.C, { id: 'a', symbol: 'C', account: 'x', date: '2025-01-06', qty: 0.2 });
  near(ev[0].cost, 0.2 * 50000 * 150); assert.equal(ev[0].est, true);
});
