// 32-0 COLLEGE overlay, loaded by the r820c bookmarklet from markjovic.github.io/82-0-tools/overlayCollege.js
// Built from the NBA overlay (v68). Own storage keys (r82c-*), own squads file, league-gated to ncaab. Model fitted 30 Oct 2026 from 333 College games.
// until the College scoring is fitted. Data-collection build: about 1 game in 3 is played with random picks ("data game").
// Reads only what the game already sends this page during normal play (each spin's squad, your picks, the final
// result) and sends nothing to the game. Scoring model fitted from 31 logged games (see MODEL); every finished game
// keeps being logged so the model can be re-checked.
(() => {
  if (window.r820) { if (window.r820.league !== 'ncaab') alert('32-0 College overlay: the NBA overlay is already running in this tab. Reload the tab, then load the College overlay.'); return; }
  // window.r820 doubles as the load guard and a machine-readable state for automation:
  //   r820.next  e.g. "TAKE|Magic Johnson|PF", "MOVE|Paul Pierce>SG|TAKE|Cliff Hagan|SF", "REROLL_TEAM|Walt Bellamy|C"
  //              (the pick after the "|" is the "otherwise take"), "RESTART", "NONE", "WAIT", "RESULT|74-8|109.2"
  //   r820.seq   increases every time the advice changes; r820.state has the same as structured fields.
  window.r820 = { version: null, next: 'WAIT', seq: 0, state: null, league: 'ncaab' };
  const VERSION = 'cv4';
  const LOG_KEY = 'r82c-log';
  const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const STATS = ['ppg', 'rpg', 'apg', 'spg', 'bpg'];
  // College model, fitted 30 Oct 2026 from 327 games (333 logged; 6 with a 1980s player missing steals or blocks fitted
  // separately). Error 0.45 points per team, leave-one-out 0.47; no bend, era effect or per-player curve improves it.
  // Team score = sum of player values + BASE. A player missing steals or blocks (about 3% of 1980s players) gets NO_DEF
  // added: fitted on only 7 games and varies 0.1-3.6, so his value is rough (about +/-1.5).
  const MODEL = { ppg: 0.4440, rpg: 0.7595, apg: 1.0464, spg: 1.0573, bpg: 0.9318, NO_DEF: 1.67, BASE: 1.3902, BPG_BEND: 2.5, BPG_EXTRA: 0, GAMES: 327, PROVISIONAL: false };
  // Score to wins: a power curve that matches all 132 games exactly (a straight line missed the 102.7 game).
  // 82 wins needs a score between 119.27 and 119.36 (narrowed by the 112.0 game); the upper end is used.
  const winsFor = s => Math.max(0, Math.min(32, Math.round(32 * Math.pow(Math.max(0, s) / 111.98, 1.1504))));   // exact on all 333 College games (30 Oct)
  const SCORE_82 = 110.5;   // 32-0 line: 110.42-110.50 fits every game; the upper end is used
  const SIMS = 800;
  const COIN_COST = 100;   // coins per re-roll once free / owned ones are used (as the game shows it)
  let coins = null;        // coin balance, read from the user record the game sends with each reply
  // Shared squad list published on the site (every club/era squad seen across all logs), merged with this browser's own.
  const SQUADS_URL = 'https://markjovic.github.io/82-0-tools/squads-college.json';
  let SITE = {}, siteNote = 'loading shared squads';

  // ---------- log ----------
  // The browser allows about 5 MB per site. Squads are the bulk, so they're stored in the same compact table form as
  // squads.json (about a third of the size) and expanded on load; the log in memory and the export are unchanged.
  const load = () => { try { const o = JSON.parse(localStorage.getItem(LOG_KEY)) || { games: [], squads: {}, actions: {} };
      if (o.squadsC) { o.squads = expandSquads(o.squadsC); delete o.squadsC; } o.squads ||= {}; return o; }
    catch (e) { return { games: [], squads: {}, actions: {} }; } };
  function compactSquads(sq) {
    const teams = {}, out = {}, st = s => [s?.ppg ?? null, s?.rpg ?? null, s?.apg ?? null, s?.spg ?? null, s?.bpg ?? null];
    const team = (t, era) => { if (t) teams[t.team_id + '|' + era] = [t.abbr, t.name, t.primary_color ?? null, t.secondary_color ?? null]; };
    for (const [k, q] of Object.entries(sq || {})) { team(q.team, q.era);
      out[k] = (q.squad || []).map(p => { const r = [String(p.player_id), p.name, (p.positions || []).join(','), ...st(p.stats)];
        if (p.prime) { team(p.prime.team, p.prime.era); r.push([String(p.prime.team_id), p.prime.era, (p.prime.positions || []).join(','), ...st(p.prime.stats)]); }
        return r; }); }
    return { format: 2, teams, squads: out }; }
  // Only players the shared list doesn't already hold are stored (College has several times the NBA's squads, and the
  // browser allows about 5 MB). Nothing is pruned until the shared list has loaded; the export is always the full log.
  function pruned(sq) { if (siteNote) return sq; const out = {};
    for (const [k, q] of Object.entries(sq || {})) { const s = SITE[k]; if (!s) { out[k] = q; continue; }
      const ids = new Set((s.squad || []).map(p => String(p.player_id))), extra = (q.squad || []).filter(p => !ids.has(String(p.player_id)));
      if (extra.length) out[k] = { ...q, squad: extra }; }
    return out; }
  let LOG = load();
  let note = '';
  const save = () => {
    const body = () => JSON.stringify({ ...LOG, squads: undefined, squadsC: compactSquads(pruned(LOG.squads)) });
    try { localStorage.setItem(LOG_KEY, body()); if (/^LOG NOT SAVED/.test(note)) note = ''; }
    catch (e) {
      // still too big: drop the small diagnostic lists (they're only samples), keep games and squads
      LOG.recentActions = (LOG.recentActions || []).slice(-10); LOG.boosterSamples = (LOG.boosterSamples || []).slice(-5); LOG.cellSamples = (LOG.cellSamples || []).slice(-5);
      try { localStorage.setItem(LOG_KEY, body()); note = ''; } catch (e2) { note = 'LOG NOT SAVED (storage full): export the log now so nothing is lost. ' + e2.message; } } };

  // ---------- model ----------
  const val = p => { const s = p?.stats || {}; return STATS.reduce((a, k) => a + MODEL[k] * (+s[k] || 0), 0) + (s.spg == null || s.bpg == null ? MODEL.NO_DEF : 0); };
  const bpgOf = p => +(p?.stats?.bpg) || 0;
  // team score: the five player values, the team adjustment, and the blocks bend
  const blockBonus = players => MODEL.BPG_EXTRA * Math.min(players.reduce((a, p) => a + bpgOf(p), 0), MODEL.BPG_BEND);
  // A draft with three primes scored 138.4 where the stats the game returned give 129.7. One game can't say how a prime
  // is scored (flat, proportional, or numbers the game doesn't show), so no bonus is assumed: PRIME_BONUS stays 0
  // until primed games (now recorded) show what it is.
  const PRIME_BONUS = 0;
  const teamScore = players => MODEL.BASE + players.reduce((a, p) => a + val(p) + (p.primed ? PRIME_BONUS : 0), 0) + blockBonus(players);
  const fits = (p, s) => (p.positions || []).includes(s);
  // A roll doesn't always list every player in that squad (the game leaves some out, e.g. Jordan from CHI 1980s once
  // he's been used elsewhere), so squads are merged player by player, never replaced: this device's version of a
  // player wins, but players only the shared list knows are kept.
  const mergeSquad = (a, b) => { if (!a) return b; if (!b) return a;
    const byId = new Map(a.squad.map(p => [String(p.player_id), p])); for (const p of b.squad) byId.set(String(p.player_id), p);
    return { ...a, ...b, squad: [...byId.values()] }; };
  let SQ = null, sqSig = '';
  const squads = () => { const sig = Object.keys(SITE).length + ':' + Object.keys(LOG.squads || {}).length + ':' + (LOG.squadsRev || 0);
    if (SQ && sig === sqSig) return SQ;
    const all = { ...SITE }; for (const [k, q] of Object.entries(LOG.squads || {})) all[k] = mergeSquad(all[k], q);
    SQ = Object.values(all).filter(q => q.squad?.length); sqSig = sig; return SQ; };
  const findPlayer = e => { const k = `${e.team_id}|${e.era}`, id = String(e.player_id);
    return LOG.squads[k]?.squad?.find(p => String(p.player_id) === id) || SITE[k]?.squad?.find(p => String(p.player_id) === id) || null; };
  // Work out which player a pick or lineup entry is. A prime pick names the player's prime stint (a different club,
  // sometimes a different era) rather than the club on offer, so look in the right places in turn.
  const resolvePick = (e, cellNow) => {
    const id = String(e.player_id);
    const exact = findPlayer(e); if (exact) return exact;
    const onOffer = (cellNow?.squad || []).find(x => String(x.player_id) === id);
    if (onOffer?.prime && String(onOffer.prime.team_id) === String(e.team_id)) return { ...onOffer.prime, player_id: onOffer.player_id, name: onOffer.name, positions: onOffer.prime.positions?.length ? onOffer.prime.positions : onOffer.positions };
    const all = squads();
    const sameClub = all.flatMap(q => q.squad).filter(x => String(x.player_id) === id && String(x.team_id) === String(e.team_id));
    if (sameClub.length) return sameClub.sort((a, b) => val(b) - val(a))[0];
    if (onOffer) return onOffer;
    const any = all.flatMap(q => q.squad).filter(x => String(x.player_id) === id);
    if (any.length) return any.sort((a, b) => val(b) - val(a))[0];
    return { player_id: e.player_id, team_id: e.team_id, era: e.era, name: e.name || `player #${e.player_id}`, positions: e.slot ? [e.slot] : [], stats: {}, unknown: true };
  };
  let PAR = null, parN = 0;
  const par = () => {   // average best value a random squad offers at each position
    const qs = squads(); if (PAR && parN === qs.length) return PAR;
    PAR = {}; parN = qs.length;
    for (const s of SLOTS) { const v = qs.map(q => Math.max(0, ...q.squad.filter(p => fits(p, s)).map(val))).filter(x => x > 0); PAR[s] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 15; }
    return PAR;
  };
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  // "32-0 calibre" for a position = at least the 25th-best value at that position across the known squads, and never
  // below 20 (32-0 needs an average of about 24 a player). Recomputed as the squad list grows.
  let ELITE = null, eliteN = 0;
  const elite = () => { const qs = squads(); if (ELITE && eliteN === qs.length) return ELITE; ELITE = {}; eliteN = qs.length;
    for (const sl of SLOTS) { const best = new Map(); for (const p of qs.flatMap(q => q.squad)) if (fits(p, sl)) best.set(p.name, Math.max(best.get(p.name) ?? -1, val(p)));
      const v = [...best.values()].sort((a, b) => b - a);
      ELITE[sl] = Math.max(20, v[24] ?? 20); }
    return ELITE; };
  // Rank of a player's value among every player in the known squads who can play that position (each club/era stint
  // counted once). Exact rank inside the top 25, a band beyond that.
  let RANKS = null, ranksN = 0;
  const posRank = (p, sl) => { const qs = squads();
    // rebuild whenever the squad list changes in any way (count alone can stay the same when the shared list
    // arrives after this device's own log, which left the ranks built from the device's squads only)
    if (!RANKS || ranksN !== sqSig) { RANKS = {}; ranksN = sqSig;
      for (const x of SLOTS) RANKS[x] = [...new Map(qs.flatMap(q => q.squad).filter(q => fits(q, x)).map(q => [String(q.player_id) + '|' + q.team_id + '|' + q.era, val(q)])).values()].sort((a, b) => b - a); }
    const v = val(p), r = RANKS[sl].filter(x => x > v + 1e-9).length + 1;
    return `#${r} ${sl}`; };
  const rankNum = (p, sl) => { posRank(p, sl); const v = val(p); return RANKS[sl].filter(x => x > v + 1e-9).length + 1; };
  // a rank as shown everywhere: #1 is a solid, glowing gold pill with a star; S-tier (2-10) is a gold outline;
  // everything else is plain text.
  const rankHtml = (p, sl, rk = rankNum(p, sl)) => rk === 1
    ? `<span style="background:#f5c542;color:#1a1a1a;font-weight:800;padding:0 5px;border-radius:4px;box-shadow:0 0 6px #f5c542">&#9733; #1 ${sl}</span>`
    : rk <= 10 ? `<span style="border:1px solid #fde68a;color:#fde68a;font-weight:700;padding:0 4px;border-radius:4px">#${rk} ${sl}</span>` : `#${rk} ${sl}`;
  // The game's own grades, read off 123 logged results: D up to 49 wins, C 50-55, B 56-61, A 62-71, A+ 72 and up.
  // The game's College grades (333 games): F Hot seat 0-12, D Bubble 13-19, C Tourney 20-22, B Contender 23-24, A Dynasty 25-28,
  // A+ Historic 29-30. 31-32 not seen yet (assumed A+).
  const GRADES = [[29, 'A+', 'Historic', '#047857'], [25, 'A', 'Dynasty', '#16a34a'], [23, 'B', 'Contender', '#0e7490'], [20, 'C', 'Tourney', '#475569'], [13, 'D', 'Bubble', '#9a3412'], [0, 'F', 'Hot seat', '#b91c1c']];
  const gradeOf = w => GRADES.find(g => w >= g[0]);
  const GOLD = '#a16207';   // reserved for a real 32-0 chance (1% or better)
  // Players can be moved between positions after they're picked, so a team is a SET of players that only needs
  // some valid arrangement. assign() finds one, keeping each player in his current position where it can.
  const assign = (players, cur, slotOrder) => {
    const order = [...players].sort((a, b) => (a.positions || []).length - (b.positions || []).length);
    const res = {};
    const bt = i => { if (i === order.length) return true; const p = order[i], pref = cur?.get(String(p.player_id));
      let rest = (p.positions || []).filter(x => x !== pref && SLOTS.includes(x));
      if (!pref && slotOrder) rest = rest.sort((x, y) => slotOrder(p, x, y));
      const opts = [...(pref ? [pref] : []), ...rest];
      for (const sl of opts) if (!res[sl] && fits(p, sl)) { res[sl] = p; if (bt(i + 1)) return true; delete res[sl]; }
      return false; };
    return bt(0) ? res : null;
  };
  const feasible = players => players.length <= 5 && assign(players) !== null;
  // best addition from a squad: the highest-value player who still leaves a valid arrangement
  const bestAdd = (squad, team, used) => { let b = null;
    const B = team.reduce((a, p) => a + bpgOf(p), 0);
    for (const p of squad) { if (used.has(String(p.player_id))) continue;
      const v = val(p) + MODEL.BPG_EXTRA * (Math.min(B + bpgOf(p), MODEL.BPG_BEND) - Math.min(B, MODEL.BPG_BEND)); if (b && v <= b.v) continue;
      if (feasible([...team, p])) b = { p, v }; }
    return b; };
  // first: {p} = take that player now; {pool: [...squads]} = re-roll into one of those squads
  function simulate(team, first, sims) {
    const qs = squads(); let hit = 0, tot = 0;
    const base = team.reduce((a, p) => a + val(p), 0);
    for (let n = 0; n < sims; n++) {
      const t = [...team], u = new Set(team.map(p => String(p.player_id))); let sum = base;
      const add = sq => { const b = bestAdd(sq, t, u); if (!b) return false; t.push(b.p); u.add(String(b.p.player_id)); sum += b.v; return true; };
      let ok;
      if (first.p) { t.push(first.p); u.add(String(first.p.player_id)); sum += val(first.p); ok = true; }
      else if (first.pair) { for (const q of first.pair) { t.push(q); u.add(String(q.player_id)); } ok = true; }
      else if (first.trade) {   // swap a drafted player out for one on this list, then still make this round's pick
        const i = t.findIndex(q => String(q.player_id) === String(first.trade.out.player_id)); if (i >= 0) t.splice(i, 1);
        t.push(first.trade.in); u.add(String(first.trade.in.player_id)); ok = add(first.trade.squad) || t.length >= 5; }
      else ok = first.pool.length ? add(rnd(first.pool).squad) : false;
      let guard = 0;
      while (ok && t.length < 5 && guard++ < 60) add(rnd(qs).squad);
      if (t.length < 5) continue;
      const score = teamScore(t); tot += score; if (score >= SCORE_82) hit++;
    }
    return { p82: hit / sims, avg: tot / Math.max(1, sims) };
  }
  // best team still reachable from the squads seen so far (upper bound for "out of reach")
  function maxReach(team) {
    const used = new Set(team.map(p => String(p.player_id)));
    const pool = squads().flatMap(q => q.squad).filter(p => !used.has(String(p.player_id))).map(p => [val(p), p]).sort((a, b) => b[0] - a[0]).slice(0, 80);
    const need = 5 - team.length; let best = -Infinity;
    const rec = (i, t, sum, k) => {
      if (k === need) { best = Math.max(best, teamScore(t)); return; }
      for (let j = i; j < pool.length; j++) { const [v, p] = pool[j]; if (MODEL.BASE + sum + v * (need - k) + MODEL.BPG_EXTRA * MODEL.BPG_BEND <= best) break;
        if (t.some(x => String(x.player_id) === String(p.player_id))) continue;
        const nt = [...t, p]; if (!feasible(nt)) continue; rec(j + 1, nt, sum + v, k + 1); } };
    rec(0, team, team.reduce((a, p) => a + val(p), 0), 0);
    return best === -Infinity ? null : best;
  }

  // ---------- live state from the game's own traffic ----------
  let cell = null, picks = {}, result = null, cache = { sig: '', html: '', rec: null };
  // Data collection: about 1 game in EXPLORE takes a random player who fits on every roll, so the fit sees weak and
  // odd teams as well as good ones (wider spread of stats and records). The choice is fixed per roll.
  const EXPLORE = 0;   // off since cv4 (model fitted); set to 1 / 3 to collect spread data again
  let exploreGame = false; const exploreDraws = new Map();
  // coverage: how many squads (club|era) are known, and how many of the last 100 rolls were new
  const coverage = () => { const qs = squads(), rn = (LOG.rollNew || []).slice(-100);
    return { squads: qs.length, clubs: new Set(qs.map(q => String(q.team?.team_id))).size, eras: [...new Set(qs.map(q => q.era))].sort(), newIn: rn.reduce((a, b) => a + b, 0), of: rn.length }; };
  // re-rolls used this game; seenStart = the overlay saw this game from its first spin, so 'unused' is known
  let rerolls = { team: false, era: false }, seenStart = false;
  const P = document.createElement('div');
  P.id = 'r820panel';   // lets the automation driver ignore the overlay's own text
  // The panel can be dragged anywhere; where you leave it is remembered in this browser.
  const POS_KEY = 'r82c-pos';
  let pos = null; try { pos = JSON.parse(localStorage.getItem(POS_KEY)); } catch (e) {}
  const BASE_CSS = 'position:fixed;z-index:99999;background:#0b2545;color:#fff;border-radius:8px;padding:7px 9px;font:12px/1.4 system-ui,sans-serif;max-width:320px;max-height:62vh;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,.35);touch-action:none;user-select:none';
  const where = () => pos ? `left:${Math.max(0, Math.min(pos.x, innerWidth - 60))}px;top:${Math.max(0, Math.min(pos.y, innerHeight - 40))}px` : 'right:6px;bottom:88px';
  const CSS_ = () => BASE_CSS + ';' + where();
  P.style.cssText = CSS_(); document.body.append(P);
  let mode = 'full';
  const BTN = 'display:inline-block;min-width:22px;text-align:center;padding:1px 6px;margin-left:4px;border-radius:5px;background:rgba(255,255,255,.18);color:#fff;font:700 13px/1.4 system-ui,sans-serif;cursor:pointer';
  // Tap anywhere on the panel to minimise / restore it. Buttons: (i) details, x hide everything, export log.
  let info = false, how = false;
  // drag: press and move more than 8px; a press that doesn't move is a tap
  let drag = null, dragged = false;
  P.addEventListener('pointerdown', e => {
    if (e.target.closest && e.target.closest('[data-r82]')) return;
    const r = P.getBoundingClientRect(); drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    P.setPointerCapture?.(e.pointerId);
  });
  P.addEventListener('pointermove', e => {
    if (!drag) return; const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true; pos = { x: drag.ox + dx, y: drag.oy + dy };
    P.style.left = pos.x + 'px'; P.style.top = pos.y + 'px'; P.style.right = 'auto'; P.style.bottom = 'auto';
  });
  let tapped = false;
  P.addEventListener('pointerup', () => {
    if (drag?.moved) { dragged = true; try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) {} }
    else if (drag) { tapped = true; mode = mode === 'full' ? 'min' : 'full'; render(); setTimeout(() => { tapped = false; }, 400); }
    drag = null;
  });
  P.addEventListener('click', e => {
    if (dragged) { dragged = false; e.stopPropagation(); return; }   // the end of a drag isn't a tap
    const m = e.target.closest && e.target.closest('[data-r82]');
    const a = m ? m.getAttribute('data-r82') : null;
    if (a === 'export') exportLog();
    else if (a === 'drv-auto' || a === 'drv-wilt' || a === 'drv-perfect') driverGo(a === 'drv-wilt' ? 'wilt' : a === 'drv-perfect' ? 'perfect' : 'advice');
    else if (a === 'drv-pause') { try { window.r82stop?.(); } catch (er) {} }
    else if (a === 'info') { info = !info; how = false; if (mode !== 'full') mode = 'full'; }
    else if (a === 'how') { how = !how; info = false; if (mode !== 'full') mode = 'full'; }
    else if (a === 'off') { hideFor(10000); e.stopPropagation(); return; }
    else if (a === 'cog') { showSettings = !showSettings; if (mode !== 'full') mode = 'full'; }
    else if (a && a.startsWith('batch:')) { SETTINGS.batch = Math.max(10, Math.min(1000, (SETTINGS.batch || 100) + +a.slice(6))); try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (er) {} }
    else if (a && a.startsWith('set:')) { const k = a.slice(4); SETTINGS[k] = !SETTINGS[k]; try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (er) {} }
    else if (a === 'drv-resume') { try { window.r82resume?.(); } catch (er) {} }
    else if (a === 'drv-cam') { try { window.r82cam?.(); } catch (er) {} }
    else if (tapped) { tapped = false; return; }               // already handled on pointerup
    else mode = mode === 'full' ? 'min' : 'full';
    e.stopPropagation(); render();
  });
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const pct = x => Math.round(x * 100) + '%';
  const rec = s => { const w = winsFor(s); return `${w}-${32 - w}`; };
  const BAN = (bg, fg, head, sub) => `<div style="background:${bg};color:${fg};border-radius:6px;padding:7px 9px;margin:-2px -3px 6px;font:800 15px/1.2 system-ui,sans-serif">${head}${sub ? `<div style="font:600 12px/1.3 system-ui,sans-serif;margin-top:3px">${sub}</div>` : ''}</div>`;
  function exportLog() {
    let driverRun = null; try { driverRun = JSON.parse(localStorage.getItem('r82c-drvlog')); } catch (e) {}
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: VERSION, ...LOG, driverRun })], { type: 'application/json' })), download: `32-0-college-log-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.json` });
    document.body.appendChild(a); a.click(); a.remove();
  }

  function advise() {
    const team = SLOTS.filter(sl => picks[sl]).map(sl => picks[sl]);
    const cur = new Map(SLOTS.filter(sl => picks[sl]).map(sl => [String(picks[sl].player_id), sl]));
    const used = new Set(team.map(p => String(p.player_id)));
    const sig = SLOTS.map(sl => sl + (picks[sl]?.player_id || '')).join() + '|' + cell.team?.team_id + cell.era + '|' + squads().length + '|' + rerolls.team + rerolls.era + '|' + JSON.stringify(cell.boosters || null) + '|' + (cell.legal || []).join() + '|' + coins + '|' + exploreGame;
    if (sig === cache.sig) return cache;
    // candidates: every player on this spin who can join the team in some arrangement, best values first
    const cands = (cell.squad || []).filter(p => !used.has(String(p.player_id)) && feasible([...team, p])).map(p => ({ p, v: val(p) })).sort((a, b) => b.v - a.v).slice(0, 6);
    // Rank by 32-0 chance, then projected score. Simulated scores carry about +/-0.3 of noise, so when two picks are
    // within 0.5 of each other the higher-value player now wins: a sure thing beats an equal-looking gamble.
    const scored = cands.map(c => ({ ...c, ...simulate(team, c, SIMS) })).sort((a, b) =>
      (Math.abs(b.p82 - a.p82) >= 0.01 ? b.p82 - a.p82 : 0) || (Math.abs(b.avg - a.avg) >= 0.5 ? b.avg - a.avg : b.v - a.v));
    let top = scored[0] || null;
    // data game: a random player who fits (fixed per roll), with no re-rolls, boosters or restart
    if (exploreGame) { const pool = (cell.squad || []).filter(p => !used.has(String(p.player_id)) && feasible([...team, p]));
      if (pool.length) { const rk = `${cell.seq}|${cell.team?.team_id}|${cell.era}`;
        if (!exploreDraws.has(rk)) exploreDraws.set(rk, Math.floor(Math.random() * 1e9));
        const p = pool[exploreDraws.get(rk) % pool.length]; top = { p, v: val(p), ...simulate(team, { p }, 200) }; } }
    // where the pick goes, and which already-picked players have to move to make room
    // Where the pick goes. A multi-position player goes to the open position where he ranks highest (his value is the
    // same everywhere, so rank is what differs); moves are still allowed later. Moves on the court are only reported by the game with your
    // next pick, so the overlay may not know a teammate's current position: instead of "move X from A to B" it says
    // where each affected teammate must be, ordered so a move into an empty position comes first.
    const placement = c => {
      // open position where he ranks highest; on a tie, the position whose top-25 line is lower (cheaper to fill well)
      const el = elite(), a = assign([...team, c.p], cur, (p, x, y) => (rankNum(p, x) - rankNum(p, y)) || ((el[x] ?? 99) - (el[y] ?? 99))) || {};
      const slot = SLOTS.find(sl => a[sl] === c.p);
      const shares = q => (q.positions || []).some(x => (c.p.positions || []).includes(x));
      const need = SLOTS.filter(sl => a[sl] && a[sl] !== c.p && (cur.get(String(a[sl].player_id)) !== sl || ((a[sl].positions || []).length > 1 && shares(a[sl]))))
        .map(sl => ({ p: a[sl], to: sl, from: cur.get(String(a[sl].player_id)), moved: cur.get(String(a[sl].player_id)) !== sl }));
      // order: a move whose target is currently empty first, then moves into positions freed by earlier ones
      const occupied = new Set([...cur.values()]), ordered = [];
      let pending = need.filter(m => m.moved), guard = 0;
      while (pending.length && guard++ < 10) {
        const ready = pending.filter(m => !occupied.has(m.to)); const next = ready.length ? ready : [pending[0]];
        for (const m of next) { ordered.push(m); occupied.delete(m.from); occupied.add(m.to); }
        pending = pending.filter(m => !next.includes(m)); }
      const moves = ordered.map(m => `${esc(m.p.name)} &rarr; ${m.to}`), movesRaw = ordered.map(m => ({ name: m.p.name, to: m.to }));
      const keep = need.filter(m => !m.moved).map(m => `${esc(m.p.name)} at ${m.to}`);
      return { slot, moves, keep, movesRaw }; };
    const qs = squads();
    const clubPool = qs.filter(q => q.era === cell.era && q.team?.team_id !== cell.team?.team_id);
    const eraPool = qs.filter(q => q.team?.team_id === cell.team?.team_id && q.era !== cell.era);
    // Re-roll availability comes from the game itself: each spin lists its boosters with how many uses are left.
    const boost = key => cell.boosters?.['respin_' + key];
    // A re-roll is available if the booster has a use left (free, owned or by ad), or failing that if the game still
    // lists "respin" as a legal action and you hold enough coins to buy one. Capped by the game's per-draft limit.
    const capped = b => b && (+b.used_in_draft || 0) >= (+b.max_per_draft || Infinity);
    const boosterUse = b => !!(b && b.enabled && b.next_use && b.next_use !== 'none' && ((+b.remaining || 0) > 0 || (+b.free_left || 0) > 0 || (+b.rv_left || 0) > 0 || (+b.owned_left || 0) > 0));
    const coinUse = b => (!b || b.enabled) && (cell.legal || []).includes('respin') && coins != null && coins >= COIN_COST;
    const avail = key => { const b = boost(key); if (!b && !cell.legal) return !rerolls[key] ? null : false;
      if (capped(b)) return false; return boosterUse(b) || coinUse(b); };
    const costNote = key => { const b = boost(key);
      if (boosterUse(b)) return b.next_use === 'free' ? '' : ` (${b.next_use === 'rv' ? 'watch an ad' : b.next_use === 'owned' ? 'uses an owned re-roll' : 'costs: ' + b.next_use})`;
      return coinUse(b) ? ` (costs ${COIN_COST} coins, you have ${coins})` : ''; };
    const reach = maxReach(team);
    // Re-rolls are only worth spending to chase 32-0: never before 3 players are in place, and only while the team
    // picked so far can still reach the 32-0 score with the best remaining picks.
    // re-rolls are only ever shown or advised when 32-0 is still possible and the team already has an S-tier player
    const sNow = SLOTS.filter(sl => picks[sl] && rankNum(picks[sl], sl) <= 10).length;
    const reachable = reach !== null && reach >= SCORE_82;
    const rerollOK = team.length >= 3 && reachable && sNow > 0;
    const showRR = reachable && sNow > 0;
    const rr = !showRR ? [] : [['Team', clubPool, 'team'], ['Era', eraPool, 'era']].filter(([, pl, key]) => pl.length && avail(key) !== false)
      .map(([name, pl, key]) => ({ name, n: pl.length, known: avail(key) === true, cost: costNote(key), ...simulate(team, { pool: pl }, SIMS) }));
    const out = reach !== null && reach < SCORE_82;
    const better = exploreGame || !rerollOK ? null : rr.filter(r => top && r.p82 - top.p82 >= 0.03).sort((a, b) => (b.p82 - a.p82) || (b.avg - a.avg))[0];
    const preferredRR = [...rr].sort((a, b) => (b.p82 - a.p82) || (b.avg - a.avg))[0] || null;   // the better of the two, whatever the odds

    // Boosters (prime, trade, double pick) are rare (earned on level-up), so they are only recommended when they
    // lift the 32-0 chance by at least BOOST_GAIN and leave it at BOOST_MIN or better.
    const BOOST_GAIN = 0.10, BOOST_MIN = 0.15, BSIMS = 400;
    const bAvail = key => { const b = cell.boosters?.[key];
      return !!(b && b.enabled !== false && b.next_use && b.next_use !== 'none' && ((+b.owned_left || 0) > 0 || (+b.remaining || 0) > 0 || (+b.free_left || 0) > 0) && (+b.used_in_draft || 0) < (+b.max_per_draft || Infinity)); };
    const boosts = [];
    if (top) {
      const offer = (cell.squad || []).filter(p => !used.has(String(p.player_id)));
      // prime: take a player as his best stint. The game names that stint in the player's "prime" entry; if it's
      // missing, use his best stint among the known squads instead.
      const bestStint = bAvail('prime') ? bestStints() : new Map();
      const primeCands = [];
      if (bAvail('prime')) for (const p of offer) {
        const src = primeOf(p, bestStint); if (!src) continue;
        const pp = { ...src, player_id: p.player_id, positions: (src.positions && src.positions.length) ? src.positions : p.positions, primed: true };
        if (val(pp) + PRIME_BONUS <= val(p) + 0.5 || val(pp) < top.v || !feasible([...team, pp])) continue;   // only worth it if he'd beat the best normal pick
        primeCands.push({ kind: 'PRIME', p: pp, base: p, v: val(pp) }); }
      for (const c of primeCands.sort((a, b) => b.v - a.v).slice(0, 3)) boosts.push({ ...c, ...simulate(team, { p: c.p }, BSIMS) });
      const topOffer = offer.filter(p => feasible([...team, p])).sort((a, b) => val(b) - val(a)).slice(0, 5);
      if (bAvail('double_pick') && team.length <= 3)          // double pick: two players from this list
        for (let i = 0; i < topOffer.length; i++) for (let k = i + 1; k < topOffer.length; k++) {
          const pair = [topOffer[i], topOffer[k]]; if (!feasible([...team, ...pair])) continue;
          boosts.push({ kind: 'DOUBLE', pair, ...simulate(team, { pair }, BSIMS) }); }
      if (bAvail('trade') && team.length)                     // trade: swap a drafted player for one on this list
        for (const inP of topOffer.slice(0, 4)) for (const outP of team) {
          if (val(inP) <= val(outP) + 1) continue;
          const after = [...team.filter(q => q !== outP), inP]; if (!feasible(after)) continue;
          boosts.push({ kind: 'TRADE', in: inP, out: outP, ...simulate(team, { trade: { in: inP, out: outP, squad: offer.filter(q => q !== inP) } }, BSIMS) }); }
    }
    const bestBoost = boosts.sort((a, b) => b.p82 - a.p82 || b.avg - a.avg)[0];
    const useBoost = !exploreGame && bestBoost && top && bestBoost.p82 - Math.max(top.p82, better ? better.p82 : 0) >= BOOST_GAIN && bestBoost.p82 >= BOOST_MIN ? bestBoost : null;

    // TOP BAR = what to do. Its colour rates the pick for its position: green = 32-0 calibre, blue = solid, amber = weak.
    // Re-roll advice uses the game's own button colours (orange team, purple era); RESTART is red.
    const bar = (bg, fg, head, sub) => `<div style="position:relative;background:${bg};color:${fg};border-radius:6px;padding:8px 34px 8px 10px;margin:-2px -3px 6px">${head}${sub ? `<div style="font:600 12px/1.35 system-ui,sans-serif;margin-top:3px">${sub}</div>` : ''}</div>`;
    const big = t => `<div style="font:800 19px/1.15 system-ui,sans-serif">${t}</div>`;
    // Grade = rank at the position the pick goes into, among every club/era stint in the known squads:
    // S top 10, A+ 11-25, A 26-50, B 51-100, C 101-200, D beyond. Same scale as the rank shown beside it.
    const tier = c => { const r = rankNum(c.p, placement(c).slot);
      return r <= 10 ? [GOLD, 'S'] : r <= 25 ? ['#047857', 'A+'] : r <= 50 ? ['#16a34a', 'A'] : r <= 100 ? ['#0e7490', 'B'] : r <= 200 ? ['#475569', 'C'] : ['#b91c1c', 'D']; };
    const pickBar = c => { const pl = placement(c), [bg, word] = tier(c);
      const head = `<div style="font:800 11px/1.2 system-ui,sans-serif;letter-spacing:.06em;opacity:.85">${pl.moves.length ? 'MOVE FIRST, THEN TAKE' : 'TAKE'}</div>${big(`${esc(c.p.name)} <span style="font-weight:700;opacity:.9">&rarr; ${pl.slot}</span>`)}`;
      const sub = `${pl.moves.length ? `<b>First move ${pl.moves.join(', then ')}.</b><br>` : ''}${pl.keep.length ? `Needs ${pl.keep.join(', ')}.<br>` : ''}${c.v.toFixed(1)} &middot; ${rankHtml(c.p, pl.slot)}<span style="position:absolute;right:9px;bottom:6px;font:800 15px/1 system-ui,sans-serif" title="S top 10 ${pl.slot}, A+ top 25, A top 50, B top 100, C top 200, D beyond">(${word})</span>`;
      return bar(bg, '#fff', head, sub); };
    let top_ = '';
    const restart = !exploreGame && team.length === 0 && top && !['S', 'A+', 'A'].includes(tier(top)[1]);
    if (!top) top_ = bar('#546e7a', '#fff', big('NOTHING TO PICK'), 'No player here can join your team in any arrangement.');
    else if (restart) top_ = bar('#991b1b', '#fff', big('RESTART THE GAME'), `Best here is ${esc(top.p.name)} &rarr; ${placement(top).slot}, ${top.v.toFixed(1)} (${tier(top)[1]}). A first pick outside the top 50 at his position leaves no realistic path.`);
    else if (useBoost) {
      const slotOf = pl => { const a = assign([...team, ...(pl.pair || [pl])], cur) || {}; return q => SLOTS.find(sl => a[sl] === q); };
      let head, sub;
      if (useBoost.kind === 'PRIME') { const sl = placement({ p: useBoost.p }).slot;
        head = `PRIME: ${esc(useBoost.p.name)} &rarr; ${sl}`; sub = `Take him as his ${esc(useBoost.p.team?.abbr || '')} ${esc(useBoost.p.era || '')} stint: value ${val(useBoost.base).toFixed(1)} &rarr; ${useBoost.v.toFixed(1)}.`; }
      else if (useBoost.kind === 'DOUBLE') { const f = slotOf({ pair: useBoost.pair });
        head = `DOUBLE PICK: ${esc(useBoost.pair[0].name)} &rarr; ${f(useBoost.pair[0])}, ${esc(useBoost.pair[1].name)} &rarr; ${f(useBoost.pair[1])}`; sub = 'Take both from this list.'; }
      else { head = `TRADE: ${esc(useBoost.out.name)} out, ${esc(useBoost.in.name)} in`; sub = `Then make this round's pick as normal.`; }
      top_ = bar('#be185d', '#fff', big(head), `${sub} 32-0 chance ${pct(top.p82)} &rarr; ${pct(useBoost.p82)} (projected ${rec(useBoost.avg)}). Uses a ${useBoost.kind === 'DOUBLE' ? 'double pick' : useBoost.kind.toLowerCase()} booster. Otherwise take ${esc(top.p.name)} &rarr; ${placement(top).slot}.`); }
    else if (better) { const era = better.name === 'Era';
      top_ = bar(era ? '#7c3aed' : '#f59e0b', era ? '#fff' : '#1a1a1a', big(`RE-ROLL ${better.name.toUpperCase()}`),
        `${better.known ? better.cost.replace(/^ \(|\)$/g, '') || 'Free re-roll available' : 'If you still have it'}. 32-0 chance ${pct(top.p82)} &rarr; ${pct(better.p82)}. Otherwise take ${esc(top.p.name)} &rarr; ${placement(top).slot}.`); }
    else top_ = pickBar(top);

    // OUTLOOK bar, below. Gold = a real 32-0 chance (1%+). Otherwise coloured by the projected record's grade.
    const chosen = useBoost || better || top;
    let oddsHtml = '';
    if (chosen && !restart) {
      const w = winsFor(chosen.avg), g = gradeOf(w);
      const real = !out && chosen.p82 >= 0.01;
      const bg = real ? GOLD : g[3];
      // 32-0 marker: struck through once it's gone, ticked while still mathematically open, a percentage once it's real
      const mark = out ? '<s style="opacity:.75">32-0</s>' : real ? `32-0 ${pct(chosen.p82)}` : '32-0 &#10003;';
      const label = `Projected ${rec(chosen.avg)} &middot; ${g[1]} &middot; ${mark}`;
      oddsHtml = `<div style="background:${bg};border-radius:6px;padding:5px 9px;margin:0 -3px 6px;font:700 13px/1.3 system-ui,sans-serif">${label}</div>`;
    }
    // always on screen: the top 4 options. Behind (i): picks so far, re-roll lines, squad counts.
    // Options: the best 4 picks on this roll, normal or primed, ranked by result. A player in the list who could be
    // primed gets his prime result on his own line; a prime only makes its own "prime only" line if it ranks in the 4.
    const bsP = bestStints(), primed = [];
    for (const p of (cell.squad || []).filter(x => !used.has(String(x.player_id)))) {
      const src = primeOf(p, bsP); if (!src) continue;
      const pp = { ...src, player_id: p.player_id, name: p.name, positions: src.positions?.length ? src.positions : p.positions, primed: true };
      if (val(pp) <= val(p) + 0.05 || !feasible([...team, pp])) continue;
      primed.push({ p: pp, base: p, v: val(pp) }); }
    const rank4 = scored.slice(0, 4).map(c => String(c.p.player_id));
    const primeSims = primed.sort((a, b) => b.v - a.v).filter((c, i) => i < 4 || rank4.includes(String(c.base.player_id)))
      .map(c => ({ ...c, ...simulate(team, { p: c.p }, 400) }));
    const byResult = (a, b) => (b.p82 - a.p82) || (b.avg - a.avg);
    // Always the top 3 normal picks, then the 4th, plus any "prime only" whose result beats that 4th pick, best first,
    // up to 6 players in all. Primes of players already listed go on their own line.
    const top3ids = scored.slice(0, 3).map(c => String(c.p.player_id)), fourth = scored[3];
    const extras = [...(fourth ? [{ kind: 'pick', c: fourth, p82: fourth.p82, avg: fourth.avg }] : []),
      ...primeSims.filter(c => !top3ids.includes(String(c.base.player_id)) && !(fourth && String(c.base.player_id) === String(fourth.p.player_id)))
        .filter(c => !fourth || byResult({ p82: fourth.p82, avg: fourth.avg }, c) > 0)
        .map(c => ({ kind: 'prime', c, p82: c.p82, avg: c.avg }))].sort(byResult);
    const shown = [...scored.slice(0, 3).map(c => ({ kind: 'pick', c })), ...extras].slice(0, 6);
    // the prime result sits on its own indented line under the player
    // colour by what the prime makes him: #1 highlighted in gold, S-tier (2-10) yellow, anyone else a quieter
    // version of the normal text so it doesn't draw the eye
    const primeTone = rk => rk === 1 ? `color:#1a1a1a;background:${GOLD};padding:0 5px;border-radius:4px;font-weight:700`
      : rk <= 10 ? 'color:#fcd34d' : 'opacity:.7';
    // The position is where he'd play in THIS team (open positions, after any moves). If he ranks better somewhere
    // the team can't use, that's shown in brackets, e.g. "#23 C (#5 SG)".
    const primeBit = c => { const pl = placement({ p: c.p }), rk = rankNum(c.p, pl.slot);
      const best = (c.p.positions || []).filter(x => SLOTS.includes(x)).map(x => [x, rankNum(c.p, x)]).sort((a, b) => a[1] - b[1])[0];
      const elsewhere = best && best[0] !== pl.slot && best[1] < rk ? ` <span style="opacity:.75">(#${best[1]} ${best[0]})</span>` : '';
      return `<div style="margin:0 0 2px 14px;font-size:12px"><span style="${rk <= 10 ? '' : primeTone(rk)}">&#128081; prime &rarr; ${rankHtml(c.p, pl.slot, rk)} &middot; ${c.v.toFixed(1)} &middot; ${rec(c.avg)}${c.p82 >= 0.01 ? ` &middot; 32-0 ${pct(c.p82)}` : ''}</span>${elsewhere}</div>`; };
    let opts = '';
    for (const e of shown) {
      if (e.kind === 'pick') { const c = e.c, pl = placement(c), pr = primeSims.find(x => String(x.base.player_id) === String(c.p.player_id));
        opts += `<div style="margin:1px 0">${c === top ? '\u2605 ' : ''}<b>${esc(c.p.name)}</b> &rarr; ${rankHtml(c.p, pl.slot)} &middot; ${c.v.toFixed(1)} &middot; ${rec(c.avg)}${c.p82 >= 0.01 ? ` &middot; 32-0 ${pct(c.p82)}` : ''}</div>${pr ? primeBit(pr) : ''}`; }
      else opts += `<div style="margin:1px 0"><b>${esc(e.c.p.name)}</b> <span style="font-size:11px;opacity:.7">(prime only)</span></div>${primeBit(e.c)}`;
    }
    let h = `Picked: ${team.length ? SLOTS.filter(sl => picks[sl]).map(sl => { const rk = rankNum(picks[sl], sl);
      return `${sl} ${esc(picks[sl].name)}${picks[sl].primed ? ' (primed)' : ''} ${rankHtml(picks[sl], sl, rk).replace(' ' + sl + '</span>', '</span>').replace(new RegExp(' ' + sl + '$'), '')} ${val(picks[sl]).toFixed(1)}`; }).join(', ') : 'none yet'}`;
    if (!rerollOK) h += `<br><small>Re-roll advice: ${team.length < 3 ? `only after 3 players are picked (${team.length} so far)` : '32-0 is no longer reachable with this team, so a re-roll would be wasted'}.</small>`;
    for (const r of rr) h += `<br>&nbsp; <span style="color:${r.name === 'Era' ? '#c4b5fd' : '#fcd34d'}">${r.name} re-roll</span>: <b>${pct(r.p82)}</b>, ${rec(r.avg)} <small>(${r.n} squads seen)</small>`;
    if (boosts.length) { const bb = boosts.slice(0, 3).map(b => `${b.kind === 'DOUBLE' ? 'double pick ' + b.pair.map(q => esc(q.name)).join(' + ') : b.kind === 'TRADE' ? 'trade ' + esc(b.out.name) + ' for ' + esc(b.in.name) : 'prime ' + esc(b.p.name)}: ${pct(b.p82)}`).join('; ');
      h += `<br><small style="color:#f9a8d4">Boosters: ${bb}${useBoost ? '' : ' (not enough gain to use one)'}</small>`; }
    if (coins != null) h += `<br><small>Coins: ${coins} (${Math.floor(coins / COIN_COST)} re-roll${Math.floor(coins / COIN_COST) === 1 ? '' : 's'} at ${COIN_COST})</small>`;
    const none = ['team', 'era'].filter(k => avail(k) === false).map(k => k === 'team' ? 'Team' : 'Era');
    if (none.length) h += `<br><small>${none.length === 2 ? 'No re-rolls left' : none[0] + ' re-roll: none left'}${cell.boosters ? ' (per the game)' : ''}.</small>`;
    // machine-readable instruction (same decision as the top bar)
    let act;
    if (!top) act = { type: 'NONE' };
    else if (restart) { const pl = placement(top); act = { type: 'RESTART', otherwise: { name: top.p.name, slot: pl.slot, moves: pl.movesRaw || [] } }; }
    else { const pl = placement(top);
      const take = { name: top.p.name, slot: pl.slot, moves: pl.movesRaw || [] };
      act = useBoost ? { type: 'BOOST_' + useBoost.kind, otherwise: take, booster: useBoost.kind }
          : better ? { type: better.name === 'Era' ? 'REROLL_ERA' : 'REROLL_TEAM', otherwise: take, cost: better.cost.replace(/^ \(|\)$/g, '') || 'free' } : { type: 'TAKE', ...take }; }
    const t = act.type === 'TAKE' ? act : act.otherwise;
    const takeStr = t ? `${t.moves.length ? 'MOVE|' + t.moves.map(m => `${m.name}>${m.to}`).join('|') + '|' : ''}TAKE|${t.name}|${t.slot}` : '';
    act.next = act.type === 'TAKE' ? takeStr : (act.type.startsWith('REROLL') || act.type.startsWith('BOOST')) ? `${act.type}|${t.name}|${t.slot}` : act.type;
    act.open = SLOTS.filter(sl => !picks[sl]); act.p82 = (better || top)?.p82 ?? null; act.projected = top ? rec((better || top).avg) : null;
    // ---- alert flags for Auto (the driver stops on whichever are switched on in settings)
    const tierOf = (p, sl) => rankNum(p, sl);
    const teamRanks = SLOTS.filter(sl => picks[sl]).map(sl => tierOf(picks[sl], sl));
    const teamS = teamRanks.filter(r => r <= 10).length, teamAllS = teamRanks.length > 0 && teamS === teamRanks.length;
    const offerNow = (cell.squad || []).filter(p => !used.has(String(p.player_id)));
    const fitsTeam = p => feasible([...team, p]);
    const bestSlotFor = p => (p.positions || []).filter(x => SLOTS.includes(x)).map(x => [x, tierOf(p, x)]).sort((a, b) => a[1] - b[1])[0] || null;
    const flags = {};
    if (team.length === 0 || teamAllS)   // a #1 is only worth stopping for on an empty team or one that's all S-tier
      for (const p of offerNow) { const b = bestSlotFor(p); if (b && b[1] === 1 && fitsTeam(p)) { flags.no1 = { name: p.name, slot: b[0] }; break; } }
    if (team.length >= 2 && teamAllS) flags.startS = { count: teamS };
    if (teamS > 0) {
      // a trade worth stopping for swaps a non-S player out for an S-tier one from this roll
      const slotOfPick = q => SLOTS.find(sl => picks[sl] === q);
      const tr = boosts.filter(b => b.kind === 'TRADE' && tierOf(b.out, slotOfPick(b.out) || (b.out.positions || [])[0]) > 10 && (bestSlotFor(b.in)?.[1] ?? 999) <= 10)
        .sort((a, b) => b.p82 - a.p82 || b.avg - a.avg)[0];
      if (tr) flags.trade = { out: tr.out.name, in: tr.in.name, p82: tr.p82 };
      if (bAvail('prime')) { const bs = bestStints();
        for (const p of offerNow) { const src = primeOf(p, bs); if (!src) continue;
          const pp = { ...src, player_id: p.player_id, positions: src.positions?.length ? src.positions : p.positions };
          if (val(pp) <= val(p) + 0.5 || !fitsTeam(pp)) continue;
          const b = bestSlotFor(pp); if (b && b[1] <= 10 && !(bestSlotFor(p)?.[1] <= 10)) { flags.primeS = { name: p.name, slot: b[0], rank: b[1], from: +val(p).toFixed(1), to: +val(pp).toFixed(1) }; break; } } }
      if (bAvail('double_pick') && team.length <= 3) {
        const sP = offerNow.filter(p => { const b = bestSlotFor(p); return b && b[1] <= 10 && fitsTeam(p); });
        outer: for (let i = 0; i < sP.length; i++) for (let k = i + 1; k < sP.length; k++) if (feasible([...team, sP[i], sP[k]])) {
          const pair = [sP[i], sP[k]], sim = boosts.find(b => b.kind === 'DOUBLE' && b.pair.includes(pair[0]) && b.pair.includes(pair[1])) || simulate(team, { pair }, BSIMS);
          flags.doubleS = { a: sP[i].name, b: sP[k].name, p82: sim.p82, rec: rec(sim.avg) }; break outer; }
      }
    }
    // what you could actually do about it: a re-roll (shown only when 32-0 is possible and you have an S-tier
    // player) or a booster. Alerts other than 32-0 only fire when there's at least one such option.
    const options = [...rr.filter(r => r.p82 >= 0.01).map(r => `${r.name.toLowerCase()} re-roll ${pct(r.p82)}`),   // a re-roll under 1% isn't a real option
      ...(flags.trade ? [`trade ${flags.trade.out} for ${flags.trade.in}`] : []), ...(flags.primeS ? [`prime ${flags.primeS.name}`] : []),
      ...(flags.doubleS ? [`double pick ${flags.doubleS.a} + ${flags.doubleS.b}`] : [])];
    flags.options = options; flags.actionable = options.length > 0;
    flags.base = top ? { p82: top.p82, rec: rec(top.avg) } : null;   // the chance without any booster, for comparison
    act.flags = flags; act.teamS = teamS;
    act.rerolls = rr.map(r => ({ name: r.name, p82: r.p82, rec: rec(r.avg), preferred: r === preferredRR }));
    // re-roll line, always visible: both options, the better one highlighted
    const rrLine = rr.length ? `<div style="margin:0 0 5px;font-size:12px">Re-roll: ${rr.map(r => `<span style="padding:1px 6px;border-radius:4px;${r === preferredRR ? `background:${r.name === 'Era' ? '#7c3aed' : '#f59e0b'};color:${r.name === 'Era' ? '#fff' : '#1a1a1a'};font-weight:700` : 'opacity:.75'}">${r.name} ${pct(r.p82)} &middot; ${rec(r.avg)}</span>`).join(' ')}</div>` : '';
    act.explore = exploreGame;
    cache = { sig, banner: (exploreGame ? '<div style="background:#334155;border-radius:5px;padding:2px 7px;margin:0 -3px 4px;font:700 11px system-ui,sans-serif">DATA GAME: random picks (for the model fit)</div>' : '') + top_ + oddsHtml + rrLine, opts: restart ? '' : opts, h, rec: top, act };
    // keep what was shown for the last 40 rolls (plain text), so a roll that flashes past in Auto can be checked later
    { const plain = x => String(x).replace(/<br>|<\/div>/g, ' | ').replace(/<[^>]+>/g, ' ').replace(/&rarr;/g, '->').replace(/&middot;/g, '·').replace(/&#128081;/g, 'PRIME').replace(/&[a-z#0-9]+;/g, '').replace(/\s+/g, ' ').trim();
      LOG.shown = [...(LOG.shown || []).slice(-39), { at: new Date().toISOString(), roll: `${cell.team?.abbr} ${cell.era}`, seq: cell.seq,
        team: SLOTS.filter(sl => picks[sl]).map(sl => sl + ' ' + picks[sl].name).join(', '), advice: plain(top_).slice(0, 300), options: plain(opts).slice(0, 900) }]; }
    return cache;
  }

  // "?" view: how the game values players and teams (from the fitted model), applied to the current pick and team
  function explain() {
    const f = (x, d = 3) => (+x).toFixed(d), W = MODEL;
    const lines = [];
    lines.push(`<b>How 32-0 scores a team</b> <small>(worked out from ${W.GAMES} of your games; the game doesn't publish it)</small>`);
    lines.push(`<b>Player value</b> = ${f(W.ppg)} &times; PPG + ${f(W.rpg)} &times; RPG + ${f(W.apg)} &times; APG + ${f(W.spg)} &times; SPG + ${f(W.bpg)} &times; BPG`);
    lines.push(`<small>Steals and blocks count about 2&ndash;4&times; a point or assist. Players missing steals or blocks (some 1980s players) get a flat +${f(W.NO_DEF, 2)} on top (rough).</small>`);
    lines.push(`<b>Team score</b> = the five values ${W.BASE < 0 ? '&minus;' : '+'} ${f(Math.abs(W.BASE), 2)}, plus ${f(W.BPG_EXTRA, 2)} for each team block up to ${f(W.BPG_BEND, 1)} <small>(so a team short on blocks is penalised harder)</small>`);
    lines.push(`<b>Record</b> = 32 &times; (score &divide; 111.98)<sup>1.150</sup>, rounded (fitted on 333 games). 32-0 needs a score of ${SCORE_82}.`);
    lines.push(`<b>Grades</b> rank a player against every club/era stint at that position: S top 10, A+ top 25, A top 50, B top 100, C top 200.`);
    const rec_ = cache?.rec;
    if (rec_ && cell) {
      const st = rec_.p.stats || {};
      const parts = STATS.map(k => st[k] == null ? null : `${(+st[k]).toFixed(1)} ${k.toUpperCase()} &times; ${f(W[k])} = <b>${(W[k] * st[k]).toFixed(1)}</b>`).filter(Boolean);
      if (st.spg == null || st.bpg == null) parts.push(`missing steals/blocks = <b>+${f(W.NO_DEF, 1)}</b>`);
      lines.push(`<hr style="border:0;border-top:1px solid #456;margin:5px 0"><b>${esc(rec_.p.name)}</b>: ${parts.join(', ')} &rarr; value <b>${val(rec_.p).toFixed(1)}</b>`);
      const team = SLOTS.filter(sl => picks[sl]).map(sl => picks[sl]);
      if (team.length) {
        const withHim = [...team, rec_.p];
        const sumV = withHim.reduce((a, p) => a + val(p), 0), bb = blockBonus(withHim), blk = withHim.reduce((a, p) => a + bpgOf(p), 0);
        lines.push(`<b>Your team with him</b> (${withHim.length} of 5): values ${withHim.map(p => val(p).toFixed(1)).join(' + ')} = ${sumV.toFixed(1)}; blocks ${blk.toFixed(1)} &rarr; +${bb.toFixed(1)}. ${withHim.length === 5 ? `Score ${teamScore(withHim).toFixed(1)} = ${rec(teamScore(withHim))}.` : `Needs about ${(SCORE_82 - W.BASE - sumV - W.BPG_EXTRA * W.BPG_BEND).toFixed(1)} more from ${5 - withHim.length} player${5 - withHim.length > 1 ? 's' : ''} for 32-0 (with a full blocks bonus).`}`);
      }
    }
    return lines.join('<br>');
  }

  // publish the current instruction for automation; seq bumps whenever it changes
  let lastPub = '';
  function publish(next, state) {
    const key = next + '|' + JSON.stringify(state);
    if (key !== lastPub) { lastPub = key; window.r820.seq++; }
    window.r820.version = VERSION; window.r820.next = next; window.r820.state = state;
  }

  // works out the advice and publishes it on window.r820, even while the panel is hidden
  function compute() {
    let banner = '', body = '', resultRows = false;
    if (result) {
      const d = result.score_display?.detail || {}, roster = result.roster || [];
      const pred = teamScore(roster.map(r => ({ ...r.player, primed: (result.primedList || []).includes(String(r.player?.player_id)) })));
      resultRows = true;
      banner = BAN('#0b3d6b', '#fff', `RESULT ${esc(result.score_display?.name ?? '')}`, `Game score ${esc(result.score)} (model said ${pred.toFixed(1)}). ${esc(d.grade ?? '')} ${esc(d.grade_label ?? '')}`);
      body = roster.map(r => `${esc(r.slot)} <b>${esc(r.player?.name)}</b> &middot; ${rankHtml(r.player, r.slot)} &middot; ${val(r.player).toFixed(1)}`).join('<br>');
      body = `<div style="margin:2px 0 4px">${body}</div>`;
      publish(`RESULT|${d.wins ?? ''}-${d.losses ?? ''}|${result.score}`, { type: 'RESULT', wins: d.wins, losses: d.losses, score: result.score, model: +pred.toFixed(1), roster: roster.map(r => ({ slot: r.slot, name: r.player?.name })) });
    } else if (cell) { const a = advise(); banner = a.banner + (a.opts || ''); body = a.h;
      const usedIds = new Set(SLOTS.filter(sl => picks[sl]).map(sl => String(picks[sl].player_id)));
      const offer = (cell.squad || []).filter(p => !usedIds.has(String(p.player_id))).map(p => ({ name: p.name, positions: p.positions, value: +val(p).toFixed(2),
        ranks: Object.fromEntries((p.positions || []).filter(x => SLOTS.includes(x)).map(x => [x, rankNum(p, x)])) }));
      // for the perfect-team hunt: each player's prime (if the game offers one) with its ranks, each pick's rank where
      // he plays, the #1 stint at every position, and what boosters and coins you have
      const bs = bestStints();
      for (const o of offer) { const p = (cell.squad || []).find(x => x.name === o.name && !usedIds.has(String(x.player_id))); const pr = p && primeOf(p, bs);
        if (pr) o.prime = { abbr: pr.team?.abbr || null, era: pr.era, value: +val(pr).toFixed(2),
          ranks: Object.fromEntries(((pr.positions && pr.positions.length) ? pr.positions : p.positions || []).filter(x => SLOTS.includes(x)).map(x => [x, rankNum(pr, x)])) }; }
      const targets = Object.fromEntries(SLOTS.map(sl => { let best = null;
        for (const q of squads()) for (const x of q.squad) if ((x.positions || []).includes(sl) && (!best || val(x) > best.v)) best = { name: x.name, abbr: q.team?.abbr, team_id: String(q.team?.team_id), era: q.era, v: val(x) };
        return [sl, best]; }));
      // re-roll odds for the hunt, per position: the chance one team re-roll (same era) or one era re-roll (same club)
      // lands a squad holding that position's #1 (directly, or by priming someone), and era-then-team in two steps
      const huntOdds = (() => { const qs = squads(), top = {}, eraTeams = {}, clubEras = {}, ok = {};
        for (const sl of SLOTS) top[sl] = Math.max(...qs.flatMap(q => q.squad).filter(x => (x.positions || []).includes(sl)).map(val));
        for (const q of qs) { const tid = String(q.team?.team_id); (eraTeams[q.era] ||= new Set()).add(tid); (clubEras[tid] ||= new Set()).add(q.era); }
        const isOne = (x, sl) => (x.positions || []).includes(sl) && val(x) >= top[sl] - 1e-9;
        for (const q of qs) for (const sl of SLOTS) if (q.squad.some(x => isOne(x, sl) || (x.prime && isOne({ ...x.prime, positions: x.prime.positions?.length ? x.prime.positions : x.positions }, sl)) || (() => { const g = bs.get(String(x.player_id)); return g && !(String(g.team_id) === String(q.team?.team_id) && g.era === q.era) && isOne({ ...g, positions: g.positions?.length ? g.positions : x.positions }, sl); })()))
          (ok[sl] ||= new Set()).add(String(q.team?.team_id) + '|' + q.era);
        const curT = String(cell.team?.team_id), curE = cell.era, out = {};
        for (const sl of SLOTS) { const A = ok[sl] || new Set();
          const teamsE = [...(eraTeams[curE] || [])].filter(t => t !== curT), erasT = [...(clubEras[curT] || [])].filter(e => e !== curE);
          const team = teamsE.length ? teamsE.filter(t => A.has(t + '|' + curE)).length / teamsE.length : 0;
          const era = erasT.length ? erasT.filter(e => A.has(curT + '|' + e)).length / erasT.length : 0;
          const eraTeam = erasT.length ? erasT.reduce((acc, e) => { const ts = [...(eraTeams[e] || [])].filter(t => t !== curT); return acc + (ts.length ? ts.filter(t => A.has(t + '|' + e)).length / ts.length : 0); }, 0) / erasT.length : 0;
          out[sl] = { team: +team.toFixed(3), era: +era.toFixed(3), eraTeam: +eraTeam.toFixed(3) }; }
        return out; })();
      publish(a.act?.next || 'NONE', { ...(a.act || { type: 'NONE' }), club: cell.team?.abbr, clubId: String(cell.team?.team_id), era: cell.era, huntOdds,
        picked: SLOTS.filter(sl => picks[sl]).map(sl => ({ slot: sl, name: picks[sl].name, rank: rankNum(picks[sl], sl), positions: picks[sl].positions || [] })),
        offer, targets, boosters: cell.boosters || {}, coins });
    } else publish('WAIT', { type: 'WAIT' });
    if (!result && !cell) body = 'Waiting for the next spin or pick. Run this before your first spin so it can follow the whole game.';
    return { banner, body, resultRows };
  }

  // A player's prime: the game names it on players it can be used on (the crown in its list). When the game sends
  // prime details for anyone on this roll, a player without one has no prime available (e.g. Westbrook on WAS 2020s,
  // which is already his prime), so only fall back to a guess when the game sends no prime details at all.
  const primeOf = (p, guesses) => {
    if (p.prime) return String(p.prime.team_id) === String(p.team_id) && p.prime.era === p.era ? null : p.prime;
    if ((cell?.squad || []).some(x => x.prime)) return null;
    const g = guesses.get(String(p.player_id));
    return g && !(String(g.team_id) === String(p.team_id) && g.era === p.era) ? g : null; };
  // each player's prime stint across the known squads, used when the game hasn't named it (cached until the squad list changes)
  let BEST = null, bestN = 0;
  const primedIds = new Set();   // players primed in the current draft
  const bestStints = () => { const qs = squads(); if (BEST && bestN === sqSig) return BEST; BEST = new Map(); bestN = sqSig;
    // the game's prime is the player's highest-scoring stint (by points per game), not the one this model values most
    for (const q of qs) for (const x of q.squad) { const k = String(x.player_id), b = BEST.get(k), ppg = +x.stats?.ppg || 0; if (!b || ppg > b.ppg) BEST.set(k, { ...x, team: q.team, ppg }); }
    return BEST; };

  // squads.json format 2 stores each squad as rows and each team once; expand it to the shape the game sends
  function expandSquads(j) {
    if (j.format !== 2) return j.squads;
    // teams are keyed "team_id|era": a franchise keeps its id but changes name and abbreviation between eras
    const T = j.teams || {}, team = (id, era) => { const t = T[id + '|' + era] || []; return { team_id: id, abbr: t[0], name: t[1], primary_color: t[2], secondary_color: t[3] }; };
    const stats = a => ({ ppg: a[0], rpg: a[1], apg: a[2], spg: a[3], bpg: a[4] });
    const out = {};
    for (const [key, rows] of Object.entries(j.squads)) {
      const [teamId, era] = key.split('|');
      out[key] = { team: team(teamId, era), era, squad: rows.map(r => {
        const p = { player_id: r[0], team_id: teamId, era, name: r[1], positions: r[2] ? r[2].split(',') : [], stats: stats(r.slice(3, 8)) };
        if (Array.isArray(r[8])) { const q = r[8]; p.prime = { player_id: r[0], team_id: q[0], era: q[1], name: r[1], positions: q[2] ? q[2].split(',') : [], stats: stats(q.slice(3, 8)), team: team(q[0], q[1]) }; }
        return p; }) };
    }
    return out;
  }

  // ---------- settings (cog): which events make Auto stop and alert you ----------
  const SETTINGS_KEY = 'r82c-settings';
  const SETTING_DEFS = [
    ['stop82', 'Stop on an 32-0 result'],
    ['no1', 'Stop when a #1-ranked player is on offer'],
    ['startS', 'After 2+ S-tier picks to start a draft, spin the next roll then stop'],
    ['trade', 'Stop when you have an S-tier player and a trade is available'],
    ['prime', 'Stop when you have an S-tier player and a prime would make one on offer S-tier'],
    ['double', 'Stop when you have an S-tier player and two S-tier players are on offer (double pick)'],
  ];
  let SETTINGS = {}; try { SETTINGS = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) {}
  for (const [k] of SETTING_DEFS) if (SETTINGS[k] === undefined) SETTINGS[k] = false;   // College: all off, so data runs go unattended (switch on in the cog)
  if (!(SETTINGS.batch >= 10)) SETTINGS.batch = 100;   // games per batch; Auto rests a minute between batches
  window.r82settings = () => ({ ...SETTINGS });
  let showSettings = false;
  const settingsHtml = () => `<div style="margin:4px 0 6px;padding:6px 8px;background:rgba(255,255,255,.08);border-radius:6px"><b>Auto: stop and alert when&hellip;</b>`
    + SETTING_DEFS.map(([k, label]) => `<div data-r82="set:${k}" style="margin-top:4px;cursor:pointer"><span style="display:inline-block;width:14px;height:14px;border:2px solid #fff;border-radius:3px;vertical-align:-3px;margin-right:6px;text-align:center;font:700 11px/12px system-ui">${SETTINGS[k] ? '&#10003;' : ''}</span>${label}</div>`).join('')
    + `<div style="margin-top:6px">Games per batch: <span data-r82="batch:-10" style="${BTN}">&minus;</span><b style="display:inline-block;min-width:34px;text-align:center">${SETTINGS.batch}</b><span data-r82="batch:10" style="${BTN}">+</span><br><small style="opacity:.8">After each batch Auto rests for a minute, then carries on.</small></div></div>`;

  // ---------- auto-driver controls ----------
  const DRIVER_URL = 'https://markjovic.github.io/82-0-tools/driverCollege.js';
  let driverLoading = false;
  function driverGo(mode) {
    if (window.r82setMode) { window.r82setMode(mode); window.r82resume(); return; }   // already loaded: switch and go
    if (driverLoading) return;
    driverLoading = true; window.r82dry = false; window.r82mode = mode;
    const sc = document.createElement('script'); sc.src = DRIVER_URL + '?v=' + Date.now();
    sc.onload = () => { driverLoading = false; render(); };
    sc.onerror = () => { driverLoading = false; note = 'AUTO-DRIVER COULD NOT BE LOADED'; render(); };
    document.head.append(sc); render();
  }
  const driverBar = () => {
    const st = window.r82state?.(), running = st?.running;
    const b = (act, label, on, title) => `<span data-r82="${act}" title="${title}" style="${BTN};${on ? 'background:#f59e0b;color:#1a1a1a' : ''}">${label}</span>`;
    const tone = st?.tone, bg = tone === 'gold' ? '#a16207' : tone === 'warn' ? '#9a3412' : tone ? '#991b1b' : 'rgba(255,255,255,.06)';
    const counts = st ? `${st.version || ''} &middot; games ${st.games}/${st.gamesEnd ?? ''} &middot; picks ${st.picks} &middot; restarts ${st.restarts}${st.errors ? ` &middot; <b>errors ${st.errors}</b>` : ''} &middot; ${st.coinsGained == null ? 'coins ?' : `+${st.coinsGained} coins`}` : driverLoading ? 'loading&hellip;' : 'off';
    const cv = coverage(), msg = (st?.msg ? `<div style="margin-top:2px">${st.msg}</div>` : '') + `<div style="margin-top:2px;opacity:.85">Squads ${cv.squads} &middot; new in last ${cv.of} rolls: ${cv.newIn} &middot; ${LOG.games.length} games logged</div>`;
    return `<div style="margin:2px -3px 5px;padding:5px 7px;border-radius:6px;background:${bg};font-size:12px"><b>Auto</b> ${st ? (running ? (st.mode === 'wilt' ? '&middot; WILT HUNT' : st.mode === 'perfect' ? '&middot; PERFECT HUNT' : '&middot; running') : st.foundWilt ? '&middot; Wilt found' : '&middot; paused') : ''} <small style="opacity:.8">${counts}</small>${msg}`
      + `<div style="margin-top:4px;display:flex;gap:2px;flex-wrap:wrap">`
      + b('drv-auto', '&#9654; Auto', running && st.mode === 'advice', 'Play drafts by the advice, stopping on the alerts in settings')
      + (running ? b('drv-pause', '&#10074;&#10074; Pause', false, 'Pause') : st ? b('drv-resume', 'Resume', false, 'Carry on in the current mode') : '')
      + (st ? b('drv-cam', st.armed ? '&#128247; armed' : st.canCapture ? '&#128247; arm' : '&#128247; manual', st.armed, st.canCapture ? 'Screenshot an 32-0 result (asks to share this tab)' : 'This device can\'t capture: overlays hide on 32-0 for your own screenshot') : '')
      + `</div></div>`;
  };
  window.r82render = () => render();
  let hideTimer = null;
  function hideFor(ms) { P.style.visibility = 'hidden'; clearTimeout(hideTimer); hideTimer = setTimeout(() => { P.style.visibility = ''; render(); }, ms); }

  function render() {
    if (ignoredLeague) { P.style.cssText = CSS_() + ';background:#8b0000'; P.innerHTML = '<b>' + esc(ignoredLeague) + '</b>'; return; }
    // hidden: a small round button where the panel was, visible on 32-0's dark page; tap it to bring the panel back
    if (mode === 'off') { compute(); P.style.cssText = `position:fixed;z-index:99999;${where()};width:30px;height:30px;border-radius:50%;background:#f59e0b;border:2px solid #fff;opacity:.75;cursor:pointer;touch-action:none;box-shadow:0 2px 8px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font:800 11px/1 system-ui,sans-serif;color:#1a1a1a`; P.innerHTML = '32'; return; }
    P.style.cssText = CSS_() + ';cursor:pointer';
    const ctl = `<div style="position:relative;z-index:3;float:right;margin:-2px -3px 2px 6px"><span data-r82="how" style="${BTN}${how ? ';background:rgba(255,255,255,.4)' : ''}" title="How players are valued">?</span><span data-r82="info" style="${BTN}${info ? ';background:rgba(255,255,255,.4)' : ''}" title="Details">i</span><span data-r82="cog" style="${BTN}${showSettings ? ';background:rgba(255,255,255,.4)' : ''}" title="Settings">&#9881;</span><span data-r82="off" style="${BTN}" title="Hide for 10 seconds">&times;</span></div>`;
    const { banner, body, resultRows } = compute();
    const all = Object.keys({ ...SITE, ...LOG.squads }).length, onlyLocal = Object.keys(LOG.squads).filter(k => !SITE[k]).length;
    const foot = `<br><small>${all} squads in use (${Object.keys(SITE).length} shared${onlyLocal ? `, ${onlyLocal} new on this device` : ''})${siteNote ? ' &middot; ' + esc(siteNote) : ''}<br>${LOG.games.length} games (${LOG.games.filter(g => g.explore).length} data games), ${Object.keys(LOG.squads).length} squads logged<br>Coverage: ${(c => `${c.squads} squads, ${c.clubs} clubs, eras ${c.eras.join(' ')}; new in last ${c.of} rolls: ${c.newIn}`)(coverage())} &middot; <span data-r82="export" style="text-decoration:underline;cursor:pointer">export log</span>${note ? ' &middot; ' + esc(note) : ''}<br>32-0 overlay ${VERSION} &middot; model from ${MODEL.GAMES} games</small>`;
    const warn = siteNote && /NOT LOADED/.test(siteNote) ? `<small style="color:#ffb74d">${esc(siteNote)}</small>` : '';
    if (mode === 'min') P.innerHTML = banner || '<b>32-0 overlay</b>';
    else P.innerHTML = ctl + banner + (showSettings ? settingsHtml() : '') + driverBar() + (how ? `<div style="font-size:12px;line-height:1.45">${explain()}</div>` : info ? body + foot : (warn || (resultRows ? body : cell || result ? '' : body))) + (`<div style="font-size:10px;opacity:.55;margin-top:2px">tap to minimise &middot; drag to move &middot; &times; hides for 10s &middot; ${VERSION}</div>`);
  }

  let sessLeague = null, ignoredLeague = '';   // league from the session/start request (else ?league= in the address)
  const _fetch = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0]?.url || args[0] || '');
    const res = await _fetch(...args);
    if (/game-session\/api\/v\d+\/session\//.test(url)) {
      let body = null; try { body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : null; } catch (e) {}
      res.clone().json().then(j => {
        try {
          if (/session\/start/.test(url) && body && body.league) sessLeague = String(body.league);
          { const lg = sessLeague || new URLSearchParams(location.search).get('league');
            if (lg && lg !== 'ncaab') { ignoredLeague = `IGNORING ${lg} games: this is the College overlay. Nothing is logged or advised. Reload the tab to use the NBA overlay.`; render(); return; } ignoredLeague = ''; }
          if (/session\/start/.test(url)) { picks = {}; cell = null; result = null; rerolls = { team: false, era: false }; seenStart = false; }
          const act = body?.action;
          if (act?.type) LOG.actions[act.type] = (LOG.actions[act.type] || 0) + 1;
          if (body && (act || body.lineup)) { LOG.recentActions = [...(LOG.recentActions || []).slice(-39), { at: new Date().toISOString(), action: act || null, lineup: body.lineup || null }]; }
          if (act?.type && act.type !== 'pick_player') LOG.actionSamples = { ...(LOG.actionSamples || {}), [act.type + ':' + (act.scope || act.booster_id || '')]: act };
          if (act?.type === 'respin') { const sc = String(act.scope || act.booster_id || ''); if (/era/i.test(sc)) rerolls.era = true; else if (/team|club/i.test(sc)) rerolls.team = true; }
          // the game sends the current arrangement with each action, so moves made on the court are picked up here
          const lineup = body?.final_roster || body?.lineup;
          if (Array.isArray(lineup) && lineup.length) {
            const byId = new Map(Object.values(picks).map(p => [String(p.player_id), p]));
            const np = {};
            for (const e of lineup) { if (!e || !e.slot) continue; np[e.slot] = byId.get(String(e.player_id)) || resolvePick(e, cell); }
            picks = np;
          }
          // any action that places a player counts as a pick (normal, prime, and the two picks of a double pick)
          const placed = act ? (Array.isArray(act.picks) ? act.picks : Array.isArray(act.players) ? act.players : act.player_id != null && act.slot ? [act] : []) : [];
          if (placed.length && cell) for (const e of placed) if (e && e.slot && e.player_id != null) {
            // a trade names the drafted player it replaces: take him off the team first
            if (e.replaces) for (const sl of SLOTS) if (picks[sl] && String(picks[sl].player_id) === String(e.replaces.player_id)) delete picks[sl];
            const p = resolvePick(e, cell);
            if (act.booster_id === 'prime') { primedIds.add(String(e.player_id)); picks[e.slot] = { ...p, primed: true }; } else picks[e.slot] = p; }
          if (act?.type && act.type !== 'pick_player') LOG.boosterSamples = [...(LOG.boosterSamples || []).slice(-19), { at: new Date().toISOString(), action: act, lineup: body?.lineup || null }];
          const bal = j?.user?.wallet?.balances;
          if (bal && bal.coin != null) { coins = +bal.coin; LOG.lastWallet = { at: new Date().toISOString(), balances: bal }; }
          if (j?.cell) {
            cell = j.cell; result = null;
            if (j.cell.seq === 0 && !act) { picks = {}; rerolls = { team: false, era: false }; seenStart = true; primedIds.clear(); exploreGame = Math.random() < EXPLORE; exploreDraws.clear(); }
            LOG.cellSamples = [...(LOG.cellSamples || []).slice(-9), { at: new Date().toISOString(), action: act?.type || null, booster: act?.booster_id || null,
              cell: Object.fromEntries(Object.entries(cell).filter(([k]) => k !== 'squad')), top: Object.fromEntries(Object.entries(j).filter(([k]) => !['cell', 'user', 'roster'].includes(k))) }];
            { const k = `${cell.team?.team_id}|${cell.era}`; LOG.rollNew = [...(LOG.rollNew || []).slice(-199), !LOG.squads[k] && !SITE[k] ? 1 : 0]; LOG.squads[k] = mergeSquad(LOG.squads[k], { team: cell.team, era: cell.era, squad: cell.squad }); LOG.squadsRev = (LOG.squadsRev || 0) + 1; }
            if (cell.boosters) LOG.lastBoosters = { at: new Date().toISOString(), legal: cell.legal, boosters: cell.boosters };
          }
          if (j && j.score != null && j.roster) {
            result = j;
            LOG.games.push({ at: new Date().toISOString(), league: 'ncaab', explore: exploreGame || undefined, game_id: j.game_id, score: j.score, display: j.score_display, mode: j.updated_stats?.game_mode,
              roster: j.roster.map(r => ({ slot: r.slot, player_id: r.player?.player_id, team_id: r.player?.team_id, era: r.player?.era, name: r.player?.name, positions: r.player?.positions, stats: r.player?.stats,
                primed: primedIds.has(String(r.player?.player_id)) || undefined,
                // anything else the game sends about this player (to find how it marks and scores primes)
                extra: Object.fromEntries([...Object.entries(r).filter(([k]) => !['slot', 'player'].includes(k)), ...Object.entries(r.player || {}).filter(([k]) => !['player_id', 'team_id', 'era', 'name', 'positions', 'stats', 'team'].includes(k)).map(([k, v]) => ['player.' + k, v])]) })),
              primed: [...primedIds] });
            result.primedList = [...primedIds];
            picks = {}; rerolls = { team: false, era: false }; seenStart = false; primedIds.clear();
          }
          save(); render();
        } catch (e) { P.style.background = '#8b0000'; P.textContent = '32-0 overlay FAILED: ' + e.message; }
      }).catch(() => {});
    }
    return res;
  };
  render();
  _fetch(SQUADS_URL, { cache: 'default' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(j => { if (!j || typeof j.squads !== 'object') throw new Error('unexpected format'); SITE = expandSquads(j); siteNote = ''; PAR = null; cache.sig = ''; render(); })
    .catch(e => { siteNote = 'SHARED SQUADS NOT LOADED (' + e.message + '); using this device only'; render(); });
})();
