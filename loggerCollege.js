// 82-0 College recon logger, loaded by the r82c bookmarklet from markjovic.github.io/82-0-tools/loggerCollege.js
// Logger only: no advice, no driver. It passively records every call the page itself makes to the game's API
// (request body + reply, never headers) into IndexedDB "r82college", completely separate from the NBA overlay's
// r82log. Export writes one JSON file with the raw calls, a summary of the data shape, and the button labels seen.
(() => {
  if (window.r82clog) return;
  const VERSION = 'c1';
  const DB_NAME = 'r82college', STORE = 'calls', LABEL_KEY = 'r82c_labels';
  const MAX_TEXT = 1000000;   // non-JSON replies longer than this are cut (flagged resTruncated); JSON is kept whole
  const ASSET = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp3|mp4|webm|wasm|map)(\?|$)/i;

  const S = { calls: 0, saved: 0, failed: 0, games: 0, dbErr: null, errs: [], mem: [], lastCell: '', lastGame: '', min: false, info: false };
  const blankSum = () => ({ endpoints: {}, leagues: {}, actions: {}, slots: {}, eras: {}, teams: {}, positions: {}, statKeys: {}, statNulls: {},
    playerKeys: {}, primeKeys: {}, cellKeys: {}, boosters: {}, finalKeys: {}, rosterSlots: {}, modes: {}, displays: [], scores: [],
    squadSizes: [], players: 0, primes: 0, maxSeq: -1, sampleAction: {}, sampleFinal: null });
  let SUM = blankSum();
  let labels = new Set(); try { labels = new Set(JSON.parse(localStorage.getItem(LABEL_KEY)) || []); } catch (e) {}

  const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const cap = (a, v, n) => { a.push(v); if (a.length > n) a.shift(); };
  const err = m => { cap(S.errs, new Date().toISOString().slice(11, 19) + ' ' + m, 8); render(); };
  const league = () => new URLSearchParams(location.search).get('league') || '(none)';

  // ---------- which calls to keep ----------
  // Anything to vaultystudios.com (the game's API host), plus JSON from 82-0.com itself. Static assets are skipped.
  const want = u => { try { const x = new URL(u, location.href); if (ASSET.test(x.pathname)) return false;
      return /(^|\.)vaultystudios\.com$/i.test(x.hostname) || /(^|\.)82-0\.com$/i.test(x.hostname); } catch (e) { return false; } };
  const isApi = u => { try { return /(^|\.)vaultystudios\.com$/i.test(new URL(u, location.href).hostname); } catch (e) { return false; } };
  const parse = t => { if (typeof t !== 'string') return { v: t, json: false }; try { return { v: JSON.parse(t), json: true }; } catch (e) { return { v: t, json: false }; } };

  // ---------- summary of the data shape (answers the recon questions) ----------
  function summarise(url, req, res) {
    let path = url; try { path = new URL(url, location.href).pathname.replace(/\/\d+(?=\/|$)/g, '/:id'); } catch (e) {}
    inc(SUM.endpoints, path); inc(SUM.leagues, league());
    const a = req && typeof req === 'object' ? req.action : null;
    if (a && a.type) { const k = a.type + (a.booster_id ? ':' + a.booster_id : a.scope ? ':' + a.scope : ''); inc(SUM.actions, k); if (!SUM.sampleAction[k]) SUM.sampleAction[k] = a; }
    for (const e of (req && Array.isArray(req.lineup) ? req.lineup : [])) if (e && e.slot) inc(SUM.slots, e.slot);
    if (!res || typeof res !== 'object') return;
    const c = res.cell;
    if (c && typeof c === 'object') {
      Object.keys(c).forEach(k => inc(SUM.cellKeys, k));
      inc(SUM.eras, String(c.era));
      if (c.team) { const id = String(c.team.team_id); (SUM.teams[id] ||= {})[`${c.team.abbr} | ${c.team.name} | ${c.era}`] = 1; }
      if (typeof c.seq === 'number') SUM.maxSeq = Math.max(SUM.maxSeq, c.seq);
      if (c.boosters && typeof c.boosters === 'object') Object.keys(c.boosters).forEach(k => inc(SUM.boosters, k));
      if (Array.isArray(c.squad)) {
        cap(SUM.squadSizes, c.squad.length, 500);
        for (const p of c.squad) { if (!p) continue; SUM.players++;
          Object.keys(p).forEach(k => inc(SUM.playerKeys, k)); (p.positions || []).forEach(x => inc(SUM.positions, String(x)));
          for (const [k, v] of Object.entries(p.stats || {})) { inc(SUM.statKeys, k); if (v == null) inc(SUM.statNulls, k); }
          if (p.prime) { SUM.primes++; Object.keys(p.prime).forEach(k => inc(SUM.primeKeys, k)); } }
      }
      S.lastCell = `${c.team?.abbr ?? '?'} ${c.era ?? '?'} · ${Array.isArray(c.squad) ? c.squad.length : '?'} players · seq ${c.seq ?? '?'}`;
    }
    if (res.score != null) {
      S.games++; Object.keys(res).forEach(k => inc(SUM.finalKeys, k));
      for (const r of Array.isArray(res.roster) ? res.roster : []) if (r && r.slot) inc(SUM.rosterSlots, r.slot);
      const d = res.score_display?.name ?? JSON.stringify(res.score_display ?? null);
      cap(SUM.displays, d, 300); cap(SUM.scores, res.score, 300); inc(SUM.modes, String(res.updated_stats?.game_mode));
      if (!SUM.sampleFinal) SUM.sampleFinal = { ...res, roster: (res.roster || []).slice(0, 1), user: undefined };
      S.lastGame = `${d} (score ${res.score})`;
    }
  }

  // ---------- storage (IndexedDB: no 5 MB limit; nothing shared with the NBA overlay) ----------
  let db = null, opening = true; const pending = [];
  const tx = (mode, fn) => new Promise((ok, bad) => { const t = db.transaction(STORE, mode); const r = fn(t.objectStore(STORE));
    t.oncomplete = () => ok(r ? r.result : undefined); t.onerror = () => bad(t.error || new Error('transaction failed')); t.onabort = () => bad(t.error || new Error('transaction aborted')); });
  const put = rec => tx('readwrite', st => st.add(rec)).then(() => { S.saved++; render(); })
    .catch(e => { S.failed++; S.dbErr = 'save failed: ' + (e && e.message); S.mem.push(rec); render(); });
  try {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { autoIncrement: true }); };
    r.onblocked = () => { opening = false; S.dbErr = 'storage blocked by another tab: close other 82-0 tabs and reload'; pending.splice(0).forEach(x => S.mem.push(x)); render(); };
    r.onerror = () => { opening = false; S.dbErr = 'storage did not open: ' + (r.error && r.error.message); pending.splice(0).forEach(x => S.mem.push(x)); render(); };
    r.onsuccess = () => { db = r.result; opening = false;
      // rebuild the counts from what earlier sessions stored, then save anything caught while opening
      tx('readonly', st => st.getAll()).then(all => { for (const x of all || []) { S.calls++; S.saved++; summarise(x.url, x.req, x.res); } pending.splice(0).forEach(put); render(); })
        .catch(e => { S.dbErr = 'could not read stored calls: ' + (e && e.message); pending.splice(0).forEach(put); render(); }); };
  } catch (e) { opening = false; S.dbErr = 'storage unavailable: ' + e.message; }

  function record(kind, method, url, status, reqText, resText, ctype) {
    const api = isApi(url), q = parse(reqText), r = parse(resText);
    if (!api && !r.json && !/json/i.test(ctype || '')) return;   // 82-0.com pages and assets: only JSON is of interest
    const rec = { at: new Date().toISOString(), href: location.href, league: league(), kind, method, url, status, req: q.v, res: r.v };
    if (!r.json && typeof r.v === 'string' && r.v.length > MAX_TEXT) { rec.res = r.v.slice(0, MAX_TEXT); rec.resTruncated = r.v.length; }
    S.calls++;
    try { summarise(url, q.v, r.json ? r.v : null); } catch (e) { err('summary: ' + e.message); }
    if (db) put(rec); else if (opening) pending.push(rec); else S.mem.push(rec);
    scanSoon(); render();
  }

  // ---------- passive taps on fetch and XHR (the page's own calls; nothing is sent or changed) ----------
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0], init = args[1] || {}, url = String((req && req.url) || req || '');
    let bodyP = null;
    if (want(url)) {
      try { bodyP = typeof init.body === 'string' ? Promise.resolve(init.body)
          : init.body != null ? Promise.resolve('[non-string body]')
          : (typeof Request !== 'undefined' && req instanceof Request) ? req.clone().text().catch(() => null) : Promise.resolve(null); }
      catch (e) { bodyP = Promise.resolve(null); err('request body: ' + e.message); }
    }
    const res = await _fetch.apply(this, args);
    if (bodyP) {
      const method = String(init.method || (req && req.method) || 'GET').toUpperCase();
      let copy = null; try { copy = res.clone(); } catch (e) { err('clone reply: ' + e.message); }
      if (copy) Promise.all([bodyP, copy.text()]).then(([b, t]) => record('fetch', method, url, res.status, b, t, res.headers.get('content-type')))
        .catch(e => err('read reply ' + url.slice(0, 60) + ': ' + e.message));
    }
    return res;
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__r82c = { m: String(m || 'GET').toUpperCase(), u: String(u) }; return XO.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (b) {
    const i = this.__r82c;
    if (i && want(i.u)) {
      const body = typeof b === 'string' ? b : b == null ? null : '[non-string body]';
      this.addEventListener('loadend', () => { try {
        const t = this.responseType === '' || this.responseType === 'text' ? this.responseText
          : this.responseType === 'json' ? JSON.stringify(this.response) : '[' + this.responseType + ' response]';
        record('xhr', i.m, i.u, this.status, body, t, this.getResponseHeader('content-type'));
      } catch (e) { err('xhr reply: ' + e.message); } });
    }
    return XS.call(this, b);
  };

  // ---------- button labels on screen (for porting the driver later) ----------
  let scanT = null;
  const scanSoon = () => { clearTimeout(scanT); scanT = setTimeout(scan, 1500); };
  function scan() {
    try { const before = labels.size;
      for (const el of document.querySelectorAll('button,[role="button"],[role="tab"],[aria-label],a[href]')) {
        if (P.contains(el) || labels.size >= 800) continue;
        const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (t) labels.add((el.getAttribute('role') || el.tagName.toLowerCase()) + ': ' + t); }
      if (labels.size !== before) localStorage.setItem(LABEL_KEY, JSON.stringify([...labels]));
    } catch (e) { err('label scan: ' + e.message); }
  }
  document.addEventListener('click', scanSoon, true);

  // ---------- export / clear ----------
  const summaryOut = () => ({ ...SUM, teams: Object.fromEntries(Object.entries(SUM.teams).map(([k, v]) => [k, Object.keys(v)])),
    squadSize: SUM.squadSizes.length ? { min: Math.min(...SUM.squadSizes), max: Math.max(...SUM.squadSizes), avg: +(SUM.squadSizes.reduce((a, b) => a + b, 0) / SUM.squadSizes.length).toFixed(1) } : null });
  async function exportLog() {
    let stored = [], readErr = null;
    if (db) { try { stored = await tx('readonly', st => st.getAll()) || []; } catch (e) { readErr = e.message; } }
    const calls = [...stored, ...S.mem, ...pending];
    const out = { exportedAt: new Date().toISOString(), version: VERSION, ua: navigator.userAgent, href: location.href, counts: { calls: calls.length, games: S.games, failedSaves: S.failed },
      storageError: S.dbErr || readErr || null, errors: S.errs, summary: summaryOut(), labels: [...labels].sort(), calls };
    const ts = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' })), download: `82-0-college-recon-${ts}.json` });
    document.body.append(a); a.click(); a.remove();
    if (readErr) alert('82-0 College logger: stored calls could NOT be read (' + readErr + '). The export only holds this session\'s unsaved calls.');
  }
  async function clearLog() {
    if (!confirm(`Delete all ${S.calls} recorded calls (${S.games} games)? Export first if you need them.`)) return;
    try { if (db) await tx('readwrite', st => st.clear()); S.mem = []; pending.length = 0; SUM = blankSum(); labels = new Set(); localStorage.removeItem(LABEL_KEY);
      Object.assign(S, { calls: 0, saved: 0, failed: 0, games: 0, lastCell: '', lastGame: '' }); }
    catch (e) { S.dbErr = 'clear failed: ' + e.message; }
    render();
  }

  // ---------- panel ----------
  const P = document.createElement('div');
  P.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483646;background:#1d1d3a;color:#fff;border-left:4px solid #fe8000;border-radius:6px;padding:7px 10px;font:12px/1.45 system-ui,sans-serif;max-width:340px;max-height:60vh;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const top = (o, n = 12) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${esc(k)} ${v}`).join(', ') || 'none yet';
  const btn = (act, t) => `<button data-r82c="${act}" style="font:600 11px system-ui;background:#fe8000;color:#fff;border:0;border-radius:4px;padding:3px 8px;margin:4px 4px 0 0;cursor:pointer">${t}</button>`;
  function render() {
    const warn = [];
    if (window.r820) warn.push('NBA overlay is also loaded in this tab: it will log these games into the NBA log. Reload the tab and load only this logger.');
    if (window.r82drv) warn.push('NBA driver is loaded in this tab. Reload the tab.');
    if (S.dbErr) warn.push('NOT SAVING: ' + S.dbErr + '. Calls are kept in memory only: export before leaving this tab.');
    if (league() === 'nba') warn.push('This tab is on Pro Basketball (league=nba). Recording anyway, tagged nba.');
    const w = warn.map(x => `<div style="background:#8b0000;padding:3px 6px;border-radius:4px;margin:3px 0">${esc(x)}</div>`).join('');
    P.style.borderLeftColor = warn.length ? '#ff3b30' : '#fe8000';
    if (S.min) { P.innerHTML = `<b>College logger</b> · ${S.calls} calls · ${S.games} games ${btn('min', '+')}`; return; }
    const info = S.info ? `<div style="margin-top:4px;opacity:.9">
      <b>Positions:</b> ${top(SUM.positions)}<br><b>Slots sent:</b> ${top(SUM.slots)}<br><b>Eras:</b> ${top(SUM.eras, 20)}<br>
      <b>Teams:</b> ${Object.keys(SUM.teams).length} ids, max seq ${SUM.maxSeq}<br>
      <b>Stats:</b> ${top(SUM.statKeys)} &middot; <b>nulls:</b> ${top(SUM.statNulls)}<br>
      <b>Primes:</b> ${SUM.primes} of ${SUM.players} player rows<br><b>Boosters:</b> ${top(SUM.boosters)}<br>
      <b>Actions:</b> ${top(SUM.actions)}<br><b>Records:</b> ${esc(SUM.displays.slice(-6).join(', ') || 'none yet')}<br>
      <b>Endpoints:</b> ${top(SUM.endpoints, 6)}<br><b>Labels seen:</b> ${labels.size}
      ${S.errs.length ? '<br><b>Errors:</b> ' + S.errs.map(esc).join('<br>') : ''}</div>` : '';
    P.innerHTML = `<b>82-0 College logger ${VERSION}</b> &middot; league=${esc(league())}${w}
      <div>Calls ${S.calls} (saved ${S.saved}${S.failed ? ', <b>failed ' + S.failed + '</b>' : ''}${S.mem.length ? ', in memory ' + S.mem.length : ''}) &middot; games ${S.games}</div>
      <div>Last roll: ${esc(S.lastCell || 'none yet')}</div><div>Last result: ${esc(S.lastGame || 'none yet')}</div>${info}
      ${btn('export', 'Export')}${btn('info', S.info ? 'Hide details' : 'Details')}${btn('clear', 'Clear')}${btn('min', '&ndash;')}`;
  }
  P.addEventListener('click', e => { e.stopPropagation(); const a = e.target.closest('[data-r82c]')?.dataset.r82c;
    if (a === 'export') exportLog().catch(x => alert('82-0 College logger: export FAILED: ' + x.message));
    else if (a === 'clear') clearLog(); else if (a === 'info') { S.info = !S.info; render(); } else if (a === 'min') { S.min = !S.min; render(); } });
  document.body.append(P);
  window.r82clog = { version: VERSION, summary: summaryOut, export: exportLog };
  render(); scanSoon();
})();
