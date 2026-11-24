/* 資産ダッシュボード 画面・状態管理。金額計算は logic.js のみ（ここで再実装しない）。 */
(function () {
  'use strict';
  const L = self.Logic, Sync = self.Sync, Chart = self.Chart;
  const VERSION = '1.0.0';
  const K_DATA = 'asset-app:data', K_SET = 'asset-app:settings';
  const ACCOUNTS = [
    { id: 'nisa_t', label: 'NISA つみたて投資枠' }, { id: 'nisa_g', label: 'NISA 成長投資枠' },
    { id: 'ideco', label: 'iDeCo' }, { id: 'tokutei', label: '特定口座' },
    { id: 'nisa_old', label: '旧NISA' }, { id: 'other', label: 'その他' }];
  const ACC = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a.label]));
  const RANGES = [['1M', 31], ['3M', 92], ['6M', 183], ['1Y', 366], ['3Y', 1096], ['全期間', 0]];
  const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
  const STALE_HOURS = 30;

  const params = new URLSearchParams(location.search);
  const DEMO = params.get('demo') === '1';
  if (params.get('dev')) Sync.setDev(params.get('dev'));

  // ---------- 状態 ----------
  const S = {
    data: { v: 1, assets: {}, entries: [], updatedAt: null },
    settings: { owner: 'fugangliang', repo: 'asset-app-data', token: '', pass: '' },
    prices: {}, status: null, index: null,
    range: '1Y', allocBy: 'account', form: null, busy: false, lastError: null,
  };
  function loadLocal() {
    try { const d = JSON.parse(localStorage.getItem(K_DATA)); if (d && d.entries) S.data = d; } catch (e) { /* 初回 */ }
    try { Object.assign(S.settings, JSON.parse(localStorage.getItem(K_SET)) || {}); } catch (e) { /* 初回 */ }
    Sync.setConfig(S.settings);
    if (DEMO) S.data = demoData();
  }
  function saveData(opts) {
    S.data.updatedAt = new Date().toISOString();
    if (DEMO) return;
    localStorage.setItem(K_DATA, JSON.stringify(S.data));
    if (!(opts && opts.local)) afterChange();
  }
  function demoData() {
    const f = { symbol: '0331418A', type: 'fund', isin: 'JP90C000H1T1', name: 'eMAXIS Slim 全世界株式(オール・カントリー)' };
    return { v: 1, updatedAt: null, assets: { '0331418A': f, VOO: { symbol: 'VOO', type: 'us', name: 'VOO' }, AAPL: { symbol: 'AAPL', type: 'us', name: 'AAPL' } },
      entries: [
        { id: 'd1', kind: 'plan', symbol: '0331418A', account: 'nisa_t', amount: 100000, day: 8, start: '2024-01', end: null, lag: 1, fee: 0, unitsNow: null },
        { id: 'd2', kind: 'plan', symbol: '0331418A', account: 'ideco', amount: 23000, day: 26, start: '2021-04', end: null, lag: 12, fee: 171, unitsNow: null },
        { id: 'd3', kind: 'lot', symbol: 'VOO', account: 'tokutei', date: '2022-06-15', qty: 20, price: null, fx: null },
        { id: 'd4', kind: 'lot', symbol: 'AAPL', account: 'nisa_g', date: '2024-03-01', qty: 30, price: 179.66, fx: 150.1 }] };
  }

  // ---------- 表示ヘルパ ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => (n == null || !isFinite(n) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'));
  const sYen = (n) => (n == null || !isFinite(n) ? '—' : (n >= 0 ? '+' : '−') + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP'));
  const sPct = (r, d) => (r == null || !isFinite(r) ? '—' : (r >= 0 ? '+' : '−') + Math.abs(r * 100).toFixed(d == null ? 1 : d) + '%');
  const cls = (n) => (n == null || !isFinite(n) || n === 0 ? '' : n > 0 ? 'up' : 'down');
  const num = (n, d) => (n == null ? '—' : n.toLocaleString('ja-JP', { maximumFractionDigits: d == null ? 2 : d }));
  const axisYen = (v) => { const a = Math.abs(v); return a >= 1e8 ? (v / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '億' : a >= 1e4 ? Math.round(v / 1e4).toLocaleString() + '万' : Math.round(v).toLocaleString(); };
  const md = (d) => (d ? (+d.slice(5, 7)) + '/' + (+d.slice(8, 10)) : '—');
  const cssVar = (v) => `var(${v})`;
  const unitLabel = (a) => (a.type === 'fund' ? '口' : '株');
  const native = (a, v) => (v == null ? '—' : a.type === 'us' ? '$' + num(v, 2) : num(v, 0) + '円');
  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }
  const parseNum = (s) => { if (s == null) return null; s = String(s).replace(/[,，\s¥$円]/g, ''); if (s === '') return null; const n = Number(s); return isFinite(n) ? n : NaN; };

  // ---------- 計算コンテキスト ----------
  function ctx() {
    return { prices: S.prices, fx: (S.prices.USDJPY && S.prices.USDJPY.rows) || [], today: L.localToday() };
  }
  const usedSymbols = () => Array.from(new Set(S.data.entries.map((e) => e.symbol)));
  const needsFx = () => usedSymbols().some((s) => S.data.assets[s] && S.data.assets[s].type === 'us');

  // ---------- 同期 ----------
  async function loadCache() {
    const all = await Sync.cacheAll();
    for (const k in all) {
      if (k.startsWith('p:')) S.prices[k.slice(2)] = all[k];
      else if (k === 'status') S.status = all[k];
      else if (k === 'index') S.index = all[k];
    }
  }
  async function refresh(manual) {
    if (!Sync.configured() || S.busy) { if (manual && !Sync.configured()) toast('設定でGitHub接続を登録してください'); return; }
    S.busy = true; S.lastError = null;
    try {
      const st = await Sync.getJson('status.json');
      if (st) { S.status = st; Sync.cacheSet('status', st); }
      const want = usedSymbols();
      if (needsFx()) want.push('USDJPY');
      await Promise.all(want.map(async (sym) => {
        const info = st && st.symbols && st.symbols[sym];
        const sig = info ? [info.last, info.close, info.n].join('|') : null;
        const have = S.prices[sym];
        if (!info && have) return;
        if (have && have.sig === sig) return;
        const p = await Sync.getJson('prices/' + sym + '.json');
        if (!p) return;
        p.sig = sig; S.prices[sym] = p; Sync.cacheSet('p:' + sym, p);
        const a = S.data.assets[sym];
        if (a && a.type === 'us' && p.name && a.name !== p.name) { a.name = p.name; if (!DEMO) localStorage.setItem(K_DATA, JSON.stringify(S.data)); }
      }));
      if (!S.index || !st || S.index.updated !== st.index_updated) {
        const idx = await Sync.getJson('funds_index.json');
        if (idx) { S.index = idx; Sync.cacheSet('index', idx); }
      }
      if (!DEMO && !Sync.readOnly()) { await syncWatchlist(); await checkCloud(); }
      if (manual) toast('最新の時価を読み込みました');
    } catch (e) {
      S.lastError = e.message; toast(e.message, 5000);
    } finally { S.busy = false; render(); }
  }
  function desiredWatchlist() {
    return { symbols: usedSymbols().sort().map((s) => { const a = S.data.assets[s]; const o = { symbol: a.symbol, type: a.type }; if (a.isin) o.isin = a.isin; if (a.type === 'fund') o.name = a.name; return o; }) };
  }
  /** 保有銘柄の一覧をデータrepoへ反映（pushでActionsが価格を取得する） */
  async function syncWatchlist() {
    const want = desiredWatchlist();
    const cur = await Sync.getJson('watchlist.json');
    const key = (w) => JSON.stringify(((w && w.symbols) || []).map((s) => [s.symbol, s.type, s.isin || '']).sort());
    if (key(cur) === key(want)) return false;
    await Sync.putText('watchlist.json', JSON.stringify(want) + '\n', 'watchlist: update');
    return true;
  }
  let changeTimer;
  function afterChange() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(async () => {
      if (!Sync.configured() || Sync.readOnly()) return;
      try {
        const pushed = await syncWatchlist();
        if (pushed) toast('銘柄一覧を更新しました。新しい銘柄の時価は1〜2分後に「更新」で反映されます', 5000);
        await backupNow(true);
      } catch (e) { S.lastError = e.message; toast(e.message, 5000); }
    }, 1200);
  }
  async function backupNow(silent) {
    if (!S.settings.pass) { if (!silent) toast('バックアップ用パスフレーズが未設定です'); return; }
    const env = await Sync.encrypt(S.settings.pass, JSON.stringify(S.data));
    env.updatedAt = S.data.updatedAt;
    await Sync.putText('backup.enc.json', JSON.stringify(env) + '\n', 'backup');
    if (!silent) toast('クラウドへバックアップしました');
  }
  async function restoreCloud(auto) {
    const env = await Sync.getJson('backup.enc.json');
    if (!env) { if (!auto) toast('クラウドにバックアップがありません'); return false; }
    const d = JSON.parse(await Sync.decrypt(S.settings.pass, env));
    if (!d || !Array.isArray(d.entries)) throw new Error('バックアップの形式が不正');
    S.data = d; localStorage.setItem(K_DATA, JSON.stringify(S.data));
    return true;
  }
  /** 別端末で更新されたバックアップがあれば取り込む（端末が空なら自動、そうでなければ確認） */
  async function checkCloud() {
    if (!S.settings.pass) return;
    const env = await Sync.getJson('backup.enc.json');
    if (!env || !env.updatedAt) return;
    const local = S.data.updatedAt || '';
    if (env.updatedAt <= local) return;
    if (S.data.entries.length && !confirm('クラウドに、この端末より新しいデータがあります。取り込みますか？\n（この端末の現在のデータは置き換えられます）')) return;
    await restoreCloud(true);
    toast('クラウドのデータを取り込みました');
    setTimeout(() => refresh(false), 50);
  }

  // ---------- 画面: ダッシュボード ----------
  function statusBanner(c) {
    const out = [];
    if (!Sync.configured()) out.push('時価の自動取得が未設定です。<a class="link" href="#/settings">設定</a>でGitHub接続を登録してください。');
    if (S.lastError) out.push('同期エラー: ' + esc(S.lastError));
    const st = S.status;
    if (st) {
      const age = (Date.now() - Date.parse(st.updated)) / 36e5;
      if (age > STALE_HOURS) out.push(`時価の取得が ${Math.floor(age)} 時間止まっています（最終取得 ${esc(st.updated.slice(0, 16).replace('T', ' '))} UTC）。`);
      const bad = usedSymbols().filter((s) => st.symbols[s] && !st.symbols[s].ok);
      if (bad.length) out.push('取得に失敗している銘柄: ' + bad.map(esc).join('、') + '（直近の取得済み価格で表示。詳細は設定）');
    }
    const noPrice = usedSymbols().filter((s) => !S.prices[s]);
    if (noPrice.length && Sync.configured()) out.push('価格をまだ取得できていない銘柄: ' + noPrice.map(esc).join('、') + '（登録直後は1〜2分後に「更新」）');
    const ev = S.events || [];
    const unres = ev.filter((e) => e.unresolved).length;
    if (unres && !noPrice.length) out.push(`購入日の価格がなく取得額を計算できない入力が ${unres} 件あります（単価を手入力してください）。`);
    return out.map((t) => `<div class="banner">${t}</div>`).join('');
  }
  function priceAsOf() {
    const ds = usedSymbols().map((s) => S.prices[s] && S.prices[s].rows.length && S.prices[s].rows[S.prices[s].rows.length - 1][0]).filter(Boolean).sort();
    if (!ds.length) return '';
    return ds[0] === ds[ds.length - 1] ? `${md(ds[0])} 終値` : `${md(ds[0])}〜${md(ds[ds.length - 1])} 終値`;
  }
  function viewHome() {
    const c = ctx(), A = S.data.assets;
    const ev = S.events = L.expandAll(c, A, S.data.entries);
    if (!S.data.entries.length) {
      return `<h1>資産ダッシュボード</h1>${statusBanner(c)}<div class="card"><p style="margin-top:0">まだ資産が登録されていません。</p>
        <p class="muted small">銘柄・購入日・数量・単価、または毎月の積立額を入力すると、時価・損益・IRRを自動計算します。</p>
        <a class="btn" href="#/add">最初の資産を登録</a></div>`;
    }
    const tot = L.summarize(c, A, ev);
    const syms = usedSymbols().map((s) => ({ a: A[s], s: L.summarize(c, A, ev.filter((e) => e.symbol === s)), accs: Array.from(new Set(S.data.entries.filter((e) => e.symbol === s).map((e) => e.account))) }))
      .sort((x, y) => y.s.value - x.s.value);
    const groups = S.allocBy === 'account'
      ? ACCOUNTS.map((ac) => ({ label: ac.label, value: L.summarize(c, A, ev.filter((e) => e.account === ac.id)).value })).filter((g) => g.value > 0)
      : syms.map((x) => ({ label: x.a.name, value: x.s.value })).filter((g) => g.value > 0);
    groups.sort((x, y) => y.value - x.value);
    let alloc = groups;
    if (groups.length > SERIES.length) {
      alloc = groups.slice(0, SERIES.length - 1);
      alloc.push({ label: 'その他', value: groups.slice(SERIES.length - 1).reduce((s, g) => s + g.value, 0), other: true });
    }
    const sum = alloc.reduce((s, g) => s + g.value, 0) || 1;
    const color = (g, i) => (g.other ? 'var(--other)' : cssVar(SERIES[i]));
    return `
      <div class="row" style="margin-bottom:8px"><h1 style="margin:0">資産ダッシュボード</h1>
        <button class="chip" data-act="refresh">${S.busy ? '更新中…' : '更新'}</button></div>
      ${statusBanner(c)}
      <div class="card">
        <div class="row"><span class="hero-label">評価額合計</span><span class="tiny">${esc(priceAsOf())}</span></div>
        <div class="hero-value num">${yen(tot.value)}</div>
        <div class="num ${cls(tot.pnl)}" style="font-weight:600">${sYen(tot.pnl)}（${sPct(tot.pct)}）<span class="muted small" style="font-weight:400"> 含み損益</span></div>
        <div class="kpis">
          <div class="kpi"><div class="k">IRR（年率）</div><div class="v num ${cls(tot.irr)}">${sPct(tot.irr)}</div></div>
          <div class="kpi"><div class="k">前日比</div><div class="v num ${cls(tot.dayChange)}">${sYen(tot.dayChange)}</div><div class="s num ${cls(tot.dayChange)}">${sPct(tot.dayPct, 2)}</div></div>
          <div class="kpi"><div class="k">投資元本</div><div class="v num">${yen(tot.cost)}</div>${tot.pendingCost ? `<div class="s muted">約定待ち ${yen(tot.pendingCost)}</div>` : ''}</div>
        </div>
      </div>
      <div class="card">
        <div class="row"><h2 style="margin:0">評価額と投資元本の推移</h2></div>
        <div class="chips" style="margin:10px 0 2px">${RANGES.map((r) => `<button class="chip" data-range="${r[0]}" aria-pressed="${S.range === r[0]}">${r[0]}</button>`).join('')}</div>
        <div class="legend"><span><i style="border-color:var(--s1)"></i>評価額</span><span><i class="dash" style="border-color:var(--ref)"></i>投資元本</span></div>
        <div id="chart-total"></div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:10px"><h2 style="margin:0">構成</h2>
          <div class="chips"><button class="chip" data-alloc="account" aria-pressed="${S.allocBy === 'account'}">口座別</button><button class="chip" data-alloc="symbol" aria-pressed="${S.allocBy === 'symbol'}">銘柄別</button></div></div>
        <div class="alloc-bar">${alloc.map((g, i) => `<span style="flex:${g.value / sum};background:${color(g, i)}" title="${esc(g.label)}"></span>`).join('')}</div>
        <div class="alloc-list">${alloc.map((g, i) => `<div class="row"><span><i style="background:${color(g, i)}"></i>${esc(g.label)}</span><span class="num">${yen(g.value)}　<span class="muted">${(g.value / sum * 100).toFixed(1)}%</span></span></div>`).join('')}</div>
      </div>
      <div class="card">
        <h2>保有銘柄</h2>
        ${syms.map((x) => `<a class="hold" href="#/h/${encodeURIComponent(x.a.symbol)}">
          <div><div class="name">${esc(x.a.name)}</div><div>${x.accs.map((a) => `<span class="tag">${esc(ACC[a] || a)}</span>`).join('')}</div></div>
          <div class="r num"><div class="val">${yen(x.s.missing ? null : x.s.value)}</div>
            <div class="small ${cls(x.s.pnl)}">${x.s.missing ? '価格未取得' : sYen(x.s.pnl) + '（' + sPct(x.s.pct) + '）'}</div>
            <div class="tiny">IRR ${sPct(x.s.irr)}</div></div></a>`).join('')}
      </div>
      <p class="tiny" style="text-align:center">IRRは購入・積立を出金、現在の評価額を入金とみなした年率の内部収益率（保有30日未満は非表示）。分配金・配当・売却・税は未反映。</p>`;
  }
  function cutRange(dates) {
    const days = (RANGES.find((r) => r[0] === S.range) || [0, 0])[1];
    if (!days || !dates.length) return 0;
    const from = L.addDays(dates[dates.length - 1], -days);
    const i = dates.findIndex((d) => d >= from);
    return i < 0 ? 0 : i;
  }
  function drawHome() {
    const host = $('#chart-total'); if (!host) return;
    const se = L.series(ctx(), S.data.assets, S.events || []);
    const i0 = cutRange(se.map((p) => p.date)), cut = se.slice(i0);
    Chart.lineChart(host, {
      label: '評価額と投資元本の推移', dates: cut.map((p) => p.date), fmtAxis: axisYen, fmtTip: yen,
      series: [{ name: '評価額', color: 'var(--s1)', values: cut.map((p) => p.value), area: true },
        { name: '投資元本', color: 'var(--ref)', values: cut.map((p) => p.cost), dash: true }],
      tipExtra: (i, v) => `<br>損益 <b>${sYen(v[0] - v[1])}</b>`,
    });
  }

  // ---------- 画面: 銘柄詳細 ----------
  function viewHolding(sym) {
    const a = S.data.assets[sym];
    const entries = S.data.entries.filter((e) => e.symbol === sym);
    if (!a || !entries.length) return `<a class="link back" href="#/">‹ 戻る</a><div class="card">この銘柄の入力はありません。</div>`;
    const c = ctx(), A = S.data.assets, p = S.prices[sym];
    const ev = L.expandAll(c, A, entries);
    const s = L.summarize(c, A, ev);
    const rows = (p && p.rows) || [];
    const last = rows[rows.length - 1], prev = rows[rows.length - 2];
    const chg = last && prev ? last[1] / prev[1] - 1 : null;
    const avg = s.units ? s.costNative / s.units * L.PER[a.type] : null;
    const accs = Array.from(new Set(entries.map((e) => e.account)));
    const st = S.status && S.status.symbols[sym];
    const perAcc = accs.length > 1 ? `<div class="card"><h2>口座別</h2>${accs.map((ac) => { const x = L.summarize(c, A, ev.filter((e) => e.account === ac)); return `<div class="hold"><div><div class="name">${esc(ACC[ac] || ac)}</div><div class="tiny num">${num(x.units, a.type === 'fund' ? 0 : 4)}${unitLabel(a)}</div></div><div class="r num"><div class="val">${yen(x.value)}</div><div class="small ${cls(x.pnl)}">${sYen(x.pnl)}（${sPct(x.pct)}）</div><div class="tiny">IRR ${sPct(x.irr)}</div></div></div>`; }).join('')}</div>` : '';
    const entryHtml = entries.map((e) => {
      const mine = ev.filter((x) => x.entryId === e.id), done = L.live(mine);
      let body;
      if (e.kind === 'plan') {
        const u = done.reduce((t, x) => t + x.units, 0), pend = mine.filter((x) => x.pending).length;
        body = `<div><b>毎月積立</b> <span class="tag">${esc(ACC[e.account] || e.account)}</span></div>
          <div class="small num">${yen(e.amount)}／月・毎月${e.day}日・${esc(e.start)}〜${esc(e.end || '継続中')}</div>
          <div class="tiny num">約定 ${done.length}回・累計 ${yen(done.reduce((t, x) => t + x.cost, 0))}・${e.unitsNow != null ? '保有' : '推定'} ${num(u, a.type === 'fund' ? 0 : 4)}${unitLabel(a)}${pend ? `・約定待ち ${pend}回` : ''}${e.fee ? `・手数料 ${yen(e.fee)}/月` : ''}</div>`;
      } else {
        const x = mine[0] || {};
        body = `<div><b>スポット購入</b> <span class="tag">${esc(ACC[e.account] || e.account)}</span></div>
          <div class="small num">${esc(e.date)}・${x.unresolved ? '数量未確定' : num(x.units, a.type === 'fund' ? 0 : 4) + unitLabel(a)}・単価 ${e.price != null ? native(a, e.price) : '当日終値（自動）'}${a.type === 'us' ? '・為替 ' + (e.fx != null ? num(e.fx, 2) : '当日（自動）') : ''}</div>
          <div class="tiny num">${x.unresolved ? '価格履歴がなく取得額を計算できません（単価を入力してください）' : '取得額 ' + yen(x.cost)}</div>`;
      }
      return `<div class="entry">${body}<div class="acts"><a class="link" href="#/edit/${e.id}">編集</a><button class="link danger" data-del="${e.id}">削除</button></div></div>`;
    }).join('');
    return `
      <a class="link back" href="#/">‹ ダッシュボード</a>
      <h1 style="margin-bottom:2px">${esc(a.name)}</h1>
      <div class="tiny" style="margin-bottom:12px">${esc(a.symbol)}・${a.type === 'fund' ? '投資信託（基準価額・1万口あたり）' : '米国株・ETF（米ドル建て）'}</div>
      ${st && !st.ok ? `<div class="banner">この銘柄の価格取得に失敗しています: ${esc(st.error)}</div>` : ''}
      ${!p ? '<div class="banner">価格をまだ取得できていません。登録直後は1〜2分後にダッシュボードの「更新」を押してください。</div>' : ''}
      <div class="card">
        <div class="row"><span class="hero-label">${a.type === 'fund' ? '基準価額' : '株価'}</span><span class="tiny">${last ? esc(last[0]) + ' 終値' : ''}</span></div>
        <div class="hero-value num" style="font-size:28px">${last ? native(a, last[1]) : '—'} <span class="small ${cls(chg)}" style="font-weight:600">${sPct(chg, 2)}</span></div>
        <div class="chips" style="margin:10px 0 2px">${RANGES.map((r) => `<button class="chip" data-range="${r[0]}" aria-pressed="${S.range === r[0]}">${r[0]}</button>`).join('')}</div>
        ${avg != null ? `<div class="legend"><span><i class="dash" style="border-color:var(--ref)"></i>平均取得単価 ${native(a, avg)}</span></div>` : ''}
        <div id="chart-price" data-sym="${esc(sym)}" data-avg="${avg == null ? '' : avg}"></div>
      </div>
      <div class="card"><div class="stats num">
        <div><div class="k">評価額</div><div class="v">${yen(s.missing ? null : s.value)}</div></div>
        <div><div class="k">含み損益</div><div class="v ${cls(s.pnl)}">${s.missing ? '—' : sYen(s.pnl)}</div><div class="small ${cls(s.pnl)}">${sPct(s.pct)}</div></div>
        <div><div class="k">IRR（年率）</div><div class="v ${cls(s.irr)}">${sPct(s.irr)}</div></div>
        <div><div class="k">前日比</div><div class="v ${cls(s.dayChange)}">${s.missing ? '—' : sYen(s.dayChange)}</div></div>
        <div><div class="k">取得額（投資元本）</div><div class="v">${yen(s.cost)}</div></div>
        <div><div class="k">保有数量</div><div class="v">${num(s.units, a.type === 'fund' ? 0 : 4)}<span class="small">${unitLabel(a)}</span></div></div>
      </div></div>
      ${perAcc}
      <div class="card"><h2>入力内容</h2>${entryHtml}
        <a class="btn sec" style="margin-top:14px" href="#/add/${encodeURIComponent(sym)}">この銘柄に追加入力</a></div>`;
  }
  function drawHolding() {
    const host = $('#chart-price'); if (!host) return;
    const sym = host.dataset.sym, a = S.data.assets[sym], p = S.prices[sym];
    const rows = (p && p.rows) || [];
    const i0 = cutRange(rows.map((r) => r[0])), cut = rows.slice(i0);
    Chart.lineChart(host, {
      label: a.name + ' の価格推移', dates: cut.map((r) => r[0]),
      fmtAxis: (v) => (a.type === 'us' ? '$' + num(v, v < 100 ? 2 : 0) : num(v, 0)), fmtTip: (v) => native(a, v),
      series: [{ name: a.type === 'fund' ? '基準価額' : '株価', color: 'var(--s1)', values: cut.map((r) => r[1]), area: true }],
      ref: host.dataset.avg ? { value: +host.dataset.avg } : null,
    });
  }

  // ---------- 画面: 入力 ----------
  function newForm(sym, entry) {
    const a = sym ? S.data.assets[sym] : null;
    const f = { id: null, type: a ? a.type : 'fund', asset: a || null, ticker: '', account: 'nisa_t', kind: 'plan', unit: 'qty',
      date: L.localToday(), qty: '', amount: '', price: '', fx: '',
      pAmount: '', day: '1', start: L.localToday().slice(0, 7), end: '', lag: '', fee: '', unitsNow: '' };
    if (entry) {
      const s = (v) => (v == null ? '' : String(v));
      Object.assign(f, { id: entry.id, type: S.data.assets[entry.symbol].type, asset: S.data.assets[entry.symbol], account: entry.account, kind: entry.kind });
      if (entry.kind === 'lot') Object.assign(f, { date: entry.date, unit: entry.qty != null ? 'qty' : 'amount', qty: s(entry.qty), amount: s(entry.amount), price: s(entry.price), fx: s(entry.fx) });
      else Object.assign(f, { pAmount: s(entry.amount), day: s(entry.day), start: entry.start, end: entry.end || '', lag: s(entry.lag), fee: s(entry.fee), unitsNow: s(entry.unitsNow) });
    } else if (a && a.type === 'us') f.kind = 'lot';
    return f;
  }
  const planDefaults = (acc) => (acc === 'ideco' ? { lag: 12, fee: 171 } : { lag: 1, fee: 0 });
  function readForm() {
    const f = S.form; if (!f) return;
    document.querySelectorAll('[data-f]').forEach((el) => { f[el.dataset.f] = el.value; });
  }
  function viewForm() {
    const f = S.form, isFund = f.type === 'fund', d = planDefaults(f.account);
    const seg = (name, opts) => `<div class="seg">${opts.map((o) => `<button type="button" data-seg="${name}" data-val="${o[0]}" aria-pressed="${f[name] === o[0]}">${o[1]}</button>`).join('')}</div>`;
    const inp = (name, label, attrs, hint) => `<label class="f"><span>${label}</span><input data-f="${name}" value="${esc(f[name])}" ${attrs || 'type="text" inputmode="decimal"'}>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
    let assetUi;
    if (f.id || f.asset) {
      assetUi = `<div class="picked"><div style="font-weight:600">${esc(f.asset.name)}</div><div class="tiny">${esc(f.asset.symbol)}</div>${f.id ? '' : '<button type="button" class="link" data-act="unpick" style="margin-top:4px">銘柄を選び直す</button>'}</div>`;
    } else if (isFund) {
      assetUi = `<label class="f"><span>銘柄（ファンド名で検索）</span><input type="search" id="fund-q" placeholder="例: slim 全世界" autocomplete="off" autocapitalize="off">
        <span class="hint">${S.index ? `投資信託協会の一覧 ${S.index.funds.length.toLocaleString()} 本から検索（スペース区切りでAND）` : '投信一覧が未取得です。設定でGitHub接続を登録し「更新」してください。'}</span>
        <div class="results" id="fund-r"></div></label>`;
    } else {
      assetUi = inp('ticker', 'ティッカー', 'type="text" autocapitalize="characters" autocomplete="off" placeholder="例: VOO"', '米国市場のティッカー（NYSE・NASDAQ）。価格は登録後に自動取得します。');
    }
    const lotUi = `
      ${inp('date', '購入日', 'type="date"')}
      ${isFund ? seg('unit', [['qty', '口数で入力'], ['amount', '金額で入力']]) : ''}
      ${isFund && f.unit === 'amount' ? inp('amount', '購入金額（円）', null, '口数は「金額 ÷ 基準価額」で計算します。')
        : inp('qty', isFund ? '購入口数' : '購入株数')}
      ${inp('price', isFund ? '購入単価（基準価額・1万口あたり・円）' : '購入単価（米ドル）', null, '空欄なら購入日の終値を自動適用します。')}
      ${isFund ? '' : inp('fx', '購入時の為替（円/ドル）', null, '空欄なら購入日の参照レートを自動適用します。')}`;
    const planUi = `
      ${inp('pAmount', '毎月の入金額（円）')}
      <div class="two">${inp('day', '引落日（毎月）', 'type="text" inputmode="numeric"', '1〜31。月末は31。')}${inp('start', '開始年月', 'type="month"')}</div>
      <div class="two">${inp('end', '終了年月（任意）', 'type="month"', '継続中は空欄。')}${inp('lag', '約定までの営業日数', `type="text" inputmode="numeric" placeholder="${d.lag}"`, `空欄は${d.lag}。`)}</div>
      ${inp('fee', '毎月の手数料（円・任意）', `type="text" inputmode="decimal" placeholder="${d.fee}"`, f.account === 'iDeCo' || f.account === 'ideco' ? '空欄は171円（国民年金基金連合会105円＋信託銀行66円の標準額）。金融機関により異なります。' : '入金額から差し引いて買付額を計算します。')}
      ${inp('unitsNow', `現在の保有${isFund ? '口数' : '株数'}（任意・補正用）`, null, '証券口座に表示される実際の数量を入れると、推定値の代わりにそれで評価します。')}`;
    return `
      ${f.id || (f.asset && S.data.assets[f.asset.symbol]) ? `<a class="link back" href="#/h/${encodeURIComponent(f.asset.symbol)}">‹ 戻る</a>` : ''}
      <h1>${f.id ? '入力の編集' : '資産の入力'}</h1>
      <div class="card">
        ${f.id || f.asset ? '' : seg('type', [['fund', '投資信託'], ['us', '米国株・ETF']])}
        ${assetUi}
        <label class="f"><span>口座</span><select data-f="account" data-rerender="1">${ACCOUNTS.map((a) => `<option value="${a.id}" ${f.account === a.id ? 'selected' : ''}>${a.label}</option>`).join('')}</select></label>
        ${f.id ? '' : seg('kind', [['plan', '毎月積立'], ['lot', 'スポット購入']])}
        ${f.kind === 'plan' ? planUi : lotUi}
        <button class="btn" data-act="save">${f.id ? '変更を保存' : '登録'}</button>
      </div>`;
  }
  function searchFunds(q) {
    const box = $('#fund-r'); if (!box) return;
    const terms = q.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || !S.index) { box.innerHTML = ''; return; }
    const hits = [];
    for (const r of S.index.funds) {
      const hay = (r[2] + ' ' + r[0]).toLowerCase().replace(/\s+/g, '');
      if (terms.every((t) => hay.includes(t))) { hits.push(r); if (hits.length >= 40) break; }
    }
    box.innerHTML = hits.length ? hits.map((r) => `<button type="button" data-fund="${esc(r[0])}">${esc(r[2])}<br><span class="tiny">${esc(r[0])}</span></button>`).join('')
      : '<button type="button" disabled>該当なし</button>';
  }
  function saveForm() {
    readForm();
    const f = S.form;
    let a = f.asset;
    if (!a) {
      if (f.type === 'fund') return toast('銘柄を検索して選択してください');
      const t = (f.ticker || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return toast('ティッカーを正しく入力してください');
      a = S.data.assets[t] || { symbol: t, type: 'us', name: t };
    }
    const n = {}; let bad = null;
    const need = (k, label, opt) => { const v = parseNum(f[k]); if (Number.isNaN(v) || (v == null && !opt) || (v != null && v < 0)) bad = bad || label + 'を正しく入力してください'; n[k] = v; };
    let e;
    if (f.kind === 'lot') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || f.date > L.localToday()) return toast('購入日を正しく入力してください（未来日は不可）');
      const byAmount = a.type === 'fund' && f.unit === 'amount';
      if (byAmount) need('amount', '購入金額'); else need('qty', '数量');
      need('price', '単価', true);
      if (a.type === 'us') need('fx', '為替', true);
      if (!bad && ((byAmount ? n.amount : n.qty) === 0 || n.price === 0 || n.fx === 0)) bad = '0は入力できません';
      e = { kind: 'lot', symbol: a.symbol, account: f.account, date: f.date, qty: byAmount ? null : n.qty, amount: byAmount ? n.amount : null, price: n.price, fx: a.type === 'us' ? n.fx : null };
    } else {
      const d = planDefaults(f.account);
      need('pAmount', '毎月の入金額'); need('day', '引落日'); need('lag', '営業日数', true); need('fee', '手数料', true); need('unitsNow', '保有数量', true);
      if (!bad && (!Number.isInteger(n.day) || n.day < 1 || n.day > 31)) bad = '引落日は1〜31で入力してください';
      if (!bad && !/^\d{4}-\d{2}$/.test(f.start)) bad = '開始年月を入力してください';
      if (!bad && f.end && f.end < f.start) bad = '終了年月が開始年月より前です';
      if (!bad && n.pAmount === 0) bad = '入金額に0は入力できません';
      const fee = n.fee == null ? d.fee : n.fee;
      if (!bad && fee >= n.pAmount) bad = '手数料が入金額以上です';
      e = { kind: 'plan', symbol: a.symbol, account: f.account, amount: n.pAmount, day: n.day, start: f.start, end: f.end || null,
        lag: n.lag == null ? d.lag : Math.round(n.lag), fee, unitsNow: n.unitsNow };
    }
    if (bad) return toast(bad);
    S.data.assets[a.symbol] = a;
    if (f.id) { e.id = f.id; S.data.entries = S.data.entries.map((x) => (x.id === f.id ? e : x)); }
    else { e.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7); S.data.entries.push(e); }
    saveData();
    S.form = null;
    toast(f.id ? '変更を保存しました' : '登録しました');
    location.hash = '#/h/' + encodeURIComponent(a.symbol);
  }

  // ---------- 画面: 設定 ----------
  function viewSettings() {
    const s = S.settings, st = S.status;
    const rows = st ? Object.keys(st.symbols).map((k) => { const x = st.symbols[k]; return `<tr><td><b>${esc(k)}</b><br><span class="tiny">${esc(x.name || '')}</span></td><td class="num" style="text-align:right">${x.ok ? esc(x.last) : '<span class="down">失敗</span>'}<br><span class="tiny">${x.ok ? num(x.close, 2) : esc(x.error || '')}</span></td></tr>`; }).join('') : '';
    return `
      <h1>設定</h1>
      <div class="card"><h2>GitHub接続（時価の取得元）</h2>
        <label class="f"><span>ユーザー名（owner）</span><input data-s="owner" type="text" value="${esc(s.owner)}" autocapitalize="off" autocomplete="off"></label>
        <label class="f"><span>データリポジトリ名</span><input data-s="repo" type="text" value="${esc(s.repo)}" autocapitalize="off" autocomplete="off"></label>
        <label class="f"><span>アクセストークン</span><input data-s="token" type="password" value="${esc(s.token)}" autocomplete="off"><span class="hint">Fine-grained token（対象=データリポジトリのみ・Contents: Read and write）。この端末内にのみ保存します。</span></label>
        <label class="f"><span>バックアップ用パスフレーズ（任意・推奨）</span><input data-s="pass" type="password" value="${esc(s.pass)}" autocomplete="off"><span class="hint">設定すると、入力データを暗号化（AES-256-GCM）してデータリポジトリへ自動バックアップします。忘れると復元できません。</span></label>
        <button class="btn" data-act="save-settings">保存して接続テスト</button>
      </div>
      <div class="card"><h2>データ</h2>
        <button class="btn sec" data-act="backup">今すぐクラウドへバックアップ</button>
        <button class="btn sec" data-act="restore">クラウドから復元</button>
        <button class="btn sec" data-act="export">ファイルに書き出す（JSON）</button>
        <button class="btn sec" data-act="import">ファイルから読み込む</button>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
        <p class="tiny" style="margin-bottom:0">入力データはこの端末内（とパスフレーズ設定時の暗号化バックアップ）にのみ保存されます。入力 ${S.data.entries.length} 件。</p>
      </div>
      <div class="card"><h2>価格の取得状況</h2>
        ${st ? `<p class="tiny" style="margin-top:0">最終取得 ${esc(new Date(st.updated).toLocaleString('ja-JP'))}${st.index_error ? '・投信一覧の更新失敗: ' + esc(st.index_error) : ''}</p><table class="st">${rows}</table>` : '<p class="muted small" style="margin:0">未取得です。</p>'}
      </div>
      <p class="tiny" style="text-align:center">v${VERSION}・価格: 投資信託協会／Nasdaq／ECB参照レート（Frankfurter）・終値ベース</p>`;
  }
  async function saveSettings() {
    document.querySelectorAll('[data-s]').forEach((el) => { S.settings[el.dataset.s] = el.value.trim(); });
    localStorage.setItem(K_SET, JSON.stringify(S.settings));
    Sync.setConfig(S.settings);
    if (!Sync.configured()) return toast('ユーザー名・リポジトリ名・トークンを入力してください');
    try {
      const st = await Sync.getJson('status.json');
      toast(st ? '接続できました' : '接続できましたが、価格データがまだありません', 3500);
      await refresh(false);
    } catch (e) { S.lastError = e.message; toast(e.message, 6000); render(); }
  }
  function exportFile() {
    const blob = new Blob([JSON.stringify(S.data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'asset-app_' + L.localToday().replace(/-/g, '') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function importFile(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || !Array.isArray(d.entries) || !d.assets) throw new Error('形式が違います');
        if (S.data.entries.length && !confirm(`現在の入力 ${S.data.entries.length} 件を、ファイルの ${d.entries.length} 件で置き換えます。よろしいですか？`)) return;
        S.data = d; saveData(); toast('読み込みました'); refresh(false); render();
      } catch (e) { toast('読み込めません: ' + e.message, 5000); }
    };
    r.readAsText(file);
  }

  // ---------- ルーティング・イベント ----------
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    return { name: parts[0] || 'home', arg: parts[1] };
  }
  let formKey = null;
  function render() {
    const r = route(), app = $('#app');
    let html, tab = 'home';
    if (r.name === 'h') html = viewHolding(r.arg);
    else if (r.name === 'add' || r.name === 'edit') {
      tab = 'add';
      const key = r.name + '/' + (r.arg || '');
      if (!S.form || formKey !== key) {
        const entry = r.name === 'edit' ? S.data.entries.find((e) => e.id === r.arg) : null;
        if (r.name === 'edit' && !entry) { location.hash = '#/'; return; }
        S.form = newForm(r.name === 'add' ? r.arg : null, entry); formKey = key;
      }
      html = viewForm();
    } else if (r.name === 'settings') { html = viewSettings(); tab = 'settings'; }
    else html = viewHome();
    if (tab !== 'add') { S.form = null; formKey = null; }
    app.innerHTML = html;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    drawHome(); drawHolding();
  }
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button, a'); if (!t) return;
    const d = t.dataset;
    try {
      if (d.range) { S.range = d.range; render(); }
      else if (d.alloc) { S.allocBy = d.alloc; render(); }
      else if (d.seg) {
        readForm(); S.form[d.seg] = d.val;
        if (d.seg === 'type') { S.form.asset = null; if (d.val === 'us') S.form.kind = 'lot'; }
        render();
      } else if (d.fund) {
        readForm();
        const r = S.index.funds.find((x) => x[0] === d.fund);
        S.form.asset = S.data.assets[r[0]] || { symbol: r[0], type: 'fund', isin: r[1], name: r[2] };
        render();
      } else if (d.del) {
        const e = S.data.entries.find((x) => x.id === d.del);
        if (e && confirm('この入力を削除しますか？')) {
          S.data.entries = S.data.entries.filter((x) => x.id !== d.del);
          saveData(); toast('削除しました');
          if (!S.data.entries.some((x) => x.symbol === e.symbol)) location.hash = '#/'; else render();
        }
      } else if (d.act === 'refresh') { S.busy || (render(), refresh(true)); }
      else if (d.act === 'unpick') { readForm(); S.form.asset = null; render(); }
      else if (d.act === 'save') saveForm();
      else if (d.act === 'save-settings') await saveSettings();
      else if (d.act === 'backup') { if (!Sync.configured()) toast('先にGitHub接続を保存してください'); else await backupNow(false); }
      else if (d.act === 'restore') {
        if (!Sync.configured() || !S.settings.pass) toast('GitHub接続とパスフレーズを先に保存してください');
        else if (!S.data.entries.length || confirm('この端末のデータをクラウドのバックアップで置き換えます。よろしいですか？')) { if (await restoreCloud(false)) { toast('復元しました'); refresh(false); render(); } }
      } else if (d.act === 'export') exportFile();
      else if (d.act === 'import') $('#import-file').click();
    } catch (e) { toast(e.message, 6000); }
  });
  document.addEventListener('input', (ev) => { if (ev.target.id === 'fund-q') searchFunds(ev.target.value); });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'import-file' && ev.target.files[0]) { importFile(ev.target.files[0]); ev.target.value = ''; }
    else if (ev.target.dataset.rerender) { readForm(); render(); }
  });
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { drawHome(); drawHolding(); }, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.status && Date.now() - (S.lastRefresh || 0) > 15 * 60000) { S.lastRefresh = Date.now(); refresh(false); } });

  // ---------- 起動 ----------
  (async function init() {
    loadLocal();
    render();
    // 端末内キャッシュの読込が詰まっても画面を止めない
    await Promise.race([loadCache(), new Promise((ok) => setTimeout(ok, 2000))]);
    render();
    S.lastRefresh = Date.now();
    refresh(false);
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
