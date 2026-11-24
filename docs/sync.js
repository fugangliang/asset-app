/* GitHub（非公開データrepo）との通信・端末内キャッシュ(IndexedDB)・バックアップ暗号化 */
(function (root) {
  'use strict';
  const API = 'https://api.github.com';
  let cfg = {};
  let dev = null; // 開発用: ?dev=<base URL> で GitHub の代わりに静的ファイルを読む（書込は無効）

  const setConfig = (c) => { cfg = c || {}; };
  const setDev = (base) => { dev = base ? base.replace(/\/?$/, '/') : null; };
  const configured = () => !!(dev || (cfg.owner && cfg.repo && cfg.token));
  const readOnly = () => !!dev;
  const url = (path) => `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/` +
    path.split('/').map(encodeURIComponent).join('/');
  const headers = (accept) => ({ Authorization: 'Bearer ' + cfg.token, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' });

  async function fail(res, what) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch (e) { /* 本文なし */ }
    const hint = res.status === 401 ? '（トークンが無効または期限切れ）' : res.status === 403 ? '（権限不足またはレート制限）' : '';
    throw new Error(`${what}に失敗: GitHub ${res.status}${hint} ${msg}`.trim());
  }
  /** JSONファイルを取得。存在しなければ null */
  async function getJson(path) {
    const res = dev
      ? await fetch(dev + path, { cache: 'no-store' })
      : await fetch(url(path), { headers: headers('application/vnd.github.raw+json'), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) await fail(res, path + ' の取得');
    return res.json();
  }
  const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  /** テキストファイルを作成／更新 */
  async function putText(path, text, message) {
    if (dev) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const meta = await fetch(url(path), { headers: headers('application/vnd.github+json'), cache: 'no-store' });
      let sha;
      if (meta.ok) sha = (await meta.json()).sha;
      else if (meta.status !== 404) await fail(meta, path + ' の確認');
      const res = await fetch(url(path), {
        method: 'PUT', headers: Object.assign(headers('application/vnd.github+json'), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message, content: b64(new TextEncoder().encode(text)), sha }),
      });
      if (res.ok) return;
      if (res.status !== 409 || attempt === 1) await fail(res, path + ' の保存');
    }
  }

  // ---- IndexedDB（価格キャッシュ） ----
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((ok, ng) => {
      const r = indexedDB.open('asset-app', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ng(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((ok, ng) => {
      const t = d.transaction('kv', mode);
      const rq = fn(t.objectStore('kv'));
      t.oncomplete = () => ok(rq && rq.result);
      t.onerror = () => ng(t.error);
    });
  }
  const cacheGet = (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined);
  const cacheSet = (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => undefined);
  const cacheAll = async () => {
    try {
      const keys = await tx('readonly', (s) => s.getAllKeys());
      const vals = await tx('readonly', (s) => s.getAll());
      const o = {}; keys.forEach((k, i) => { o[k] = vals[i]; });
      return o;
    } catch (e) { return {}; }
  };

  // ---- バックアップ暗号化（PBKDF2-SHA256 → AES-256-GCM） ----
  const ITER = 250000;
  async function key(pass, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(pass, text) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(pass, salt), new TextEncoder().encode(text));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }
  async function decrypt(pass, env) {
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, await key(pass, unb64(env.salt)), unb64(env.ct));
      return new TextDecoder().decode(pt);
    } catch (e) { throw new Error('復号に失敗（パスフレーズが違う可能性）'); }
  }

  root.Sync = { setConfig, setDev, configured, readOnly, getJson, putText, cacheGet, cacheSet, cacheAll, encrypt, decrypt };
})(self);
