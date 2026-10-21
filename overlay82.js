// 82-0 overlay v2, loaded by the r820 bookmarklet from markjovic.github.io/82-0-tools/overlay82.js
// Reads only what the game already sends this page during normal play (each spin's squad, your picks, the final
// result) and sends nothing to the game. Scoring model fitted from 31 logged games (see MODEL); every finished game
// keeps being logged so the model can be re-checked.
(() => {
  if (window.r820) return;
  // window.r820 doubles as the load guard and a machine-readable state for automation:
  //   r820.next  e.g. "TAKE|Magic Johnson|PF", "MOVE|Paul Pierce>SG|TAKE|Cliff Hagan|SF", "REROLL_TEAM|Walt Bellamy|C"
  //              (the pick after the "|" is the "otherwise take"), "RESTART", "NONE", "WAIT", "RESULT|74-8|109.2"
  //   r820.seq   increases every time the advice changes; r820.state has the same as structured fields.
  window.r820 = { version: null, next: 'WAIT', seq: 0, state: null };
  const VERSION = 'v34';
  const LOG_KEY = 'r82log';
  const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const STATS = ['ppg', 'rpg', 'apg', 'spg', 'bpg'];
  // Refitted 21 Oct 2026 from 139 games. Team blocks have a bend: below BPG_BEND team blocks, each block is worth
  // BPG_EXTRA more (low-block teams are penalised harder). Leave-one-out error 0.37 (was 0.49 without the bend).: team score = sum of player values + BASE.
  // A player with no steals/blocks on record (1960s, early 1970s) gets NO_DEF instead.
  const MODEL = { ppg: 0.3360, rpg: 0.6157, apg: 0.6155, spg: 1.2727, bpg: 1.3697, NO_DEF: 3.3117, BASE: -3.3875, BPG_BEND: 2.10, BPG_EXTRA: 1.6617, GAMES: 139 };
  // Score to wins: a power curve that matches all 132 games exactly (a straight line missed the 102.7 game).
  // 82 wins needs a score between 119.27 and 119.36 (narrowed by the 112.0 game); the upper end is used.
  const winsFor = s => Math.max(0, Math.min(82, Math.round(82 * Math.pow(Math.max(0, s) / 119.9, 1.155))));
  const SCORE_82 = 119.36;
  const SIMS = 800;
  const COIN_COST = 100;   // coins per re-roll once free / owned ones are used (as the game shows it)
  let coins = null;        // coin balance, read from the user record the game sends with each reply
  // Shared squad list published on the site (every club/era squad seen across all logs), merged with this browser's own.
  const SQUADS_URL = 'https://markjovic.github.io/82-0-tools/squads.json';
  let SITE = {}, siteNote = 'loading shared squads';

  // ---------- log ----------
  const load = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY)) || { games: [], squads: {}, actions: {} }; } catch (e) { return { games: [], squads: {}, actions: {} }; } };
  let LOG = load();
  let note = '';
  const save = () => { try { localStorage.setItem(LOG_KEY, JSON.stringify(LOG)); } catch (e) { note = 'LOG NOT SAVED: ' + e.message; } };

  // ---------- model ----------
  const val = p => { const s = p?.stats || {}; return STATS.reduce((a, k) => a + MODEL[k] * (+s[k] || 0), 0) + (s.spg == null && s.bpg == null ? MODEL.NO_DEF : 0); };
  const bpgOf = p => +(p?.stats?.bpg) || 0;
  // team score: the five player values, the team adjustment, and the blocks bend
  const blockBonus = players => MODEL.BPG_EXTRA * Math.min(players.reduce((a, p) => a + bpgOf(p), 0), MODEL.BPG_BEND);
  const teamScore = players => MODEL.BASE + players.reduce((a, p) => a + val(p), 0) + blockBonus(players);
  const fits = (p, s) => (p.positions || []).includes(s);
  const squads = () => Object.values({ ...SITE, ...LOG.squads }).filter(q => q.squad?.length);
  const findPlayer = e => { const q = LOG.squads[`${e.team_id}|${e.era}`] || SITE[`${e.team_id}|${e.era}`]; return q?.squad?.find(p => String(p.player_id) === String(e.player_id)) || null; };
  let PAR = null, parN = 0;
  const par = () => {   // average best value a random squad offers at each position
    const qs = squads(); if (PAR && parN === qs.length) return PAR;
    PAR = {}; parN = qs.length;
    for (const s of SLOTS) { const v = qs.map(q => Math.max(0, ...q.squad.filter(p => fits(p, s)).map(val))).filter(x => x > 0); PAR[s] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 15; }
    return PAR;
  };
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  // "82-0 calibre" for a position = at least the 25th-best value at that position across the known squads, and never
  // below 20 (82-0 needs an average of about 24 a player). Recomputed as the squad list grows.
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
    if (!RANKS || ranksN !== qs.length) { RANKS = {}; ranksN = qs.length;
      for (const x of SLOTS) RANKS[x] = [...new Map(qs.flatMap(q => q.squad).filter(q => fits(q, x)).map(q => [String(q.player_id) + '|' + q.team_id + '|' + q.era, val(q)])).values()].sort((a, b) => b - a); }
    const v = val(p), r = RANKS[sl].filter(x => x > v + 1e-9).length + 1;
    return `#${r} ${sl}`; };
  const rankNum = (p, sl) => { posRank(p, sl); const v = val(p); return RANKS[sl].filter(x => x > v + 1e-9).length + 1; };
  // The game's own grades, read off 123 logged results: D up to 49 wins, C 50-55, B 56-61, A 62-71, A+ 72 and up.
  const GRADES = [[72, 'A+', 'Historic', '#047857'], [62, 'A', 'Dynasty', '#16a34a'], [56, 'B', 'Contender', '#0e7490'], [50, 'C', 'Playoff', '#b45309'], [0, 'D', 'Lottery', '#b91c1c']];
  const gradeOf = w => GRADES.find(g => w >= g[0]);
  const GOLD = '#a16207';   // reserved for a real 82-0 chance (1% or better)
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
  // re-rolls used this game; seenStart = the overlay saw this game from its first spin, so 'unused' is known
  let rerolls = { team: false, era: false }, seenStart = false;
  const P = document.createElement('div');
  P.id = 'r820panel';   // lets the automation driver ignore the overlay's own text
  // The panel can be dragged anywhere; where you leave it is remembered in this browser.
  const POS_KEY = 'r82pos';
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
    else if (a === 'drv-auto' || a === 'drv-wilt') driverGo(a === 'drv-wilt' ? 'wilt' : 'advice');
    else if (a === 'drv-pause') { try { window.r82stop?.(); } catch (er) {} }
    else if (a === 'info') { info = !info; how = false; if (mode !== 'full') mode = 'full'; }
    else if (a === 'how') { how = !how; info = false; if (mode !== 'full') mode = 'full'; }
    else if (a === 'off') mode = 'off';
    else if (tapped) { tapped = false; return; }               // already handled on pointerup
    else mode = mode === 'full' ? 'min' : 'full';
    e.stopPropagation(); render();
  });
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const pct = x => Math.round(x * 100) + '%';
  const rec = s => { const w = winsFor(s); return `${w}-${82 - w}`; };
  const BAN = (bg, fg, head, sub) => `<div style="background:${bg};color:${fg};border-radius:6px;padding:7px 9px;margin:-2px -3px 6px;font:800 15px/1.2 system-ui,sans-serif">${head}${sub ? `<div style="font:600 12px/1.3 system-ui,sans-serif;margin-top:3px">${sub}</div>` : ''}</div>`;
  function exportLog() {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: VERSION, ...LOG })], { type: 'application/json' })), download: '82-0-log.json' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  function advise() {
    const team = SLOTS.filter(sl => picks[sl]).map(sl => picks[sl]);
    const cur = new Map(SLOTS.filter(sl => picks[sl]).map(sl => [String(picks[sl].player_id), sl]));
    const used = new Set(team.map(p => String(p.player_id)));
    const sig = SLOTS.map(sl => sl + (picks[sl]?.player_id || '')).join() + '|' + cell.team?.team_id + cell.era + '|' + squads().length + '|' + rerolls.team + rerolls.era + '|' + JSON.stringify(cell.boosters || null) + '|' + (cell.legal || []).join() + '|' + coins;
    if (sig === cache.sig) return cache;
    // candidates: every player on this spin who can join the team in some arrangement, best values first
    const cands = (cell.squad || []).filter(p => !used.has(String(p.player_id)) && feasible([...team, p])).map(p => ({ p, v: val(p) })).sort((a, b) => b.v - a.v).slice(0, 6);
    // Rank by 82-0 chance, then projected score. Simulated scores carry about +/-0.3 of noise, so when two picks are
    // within 0.5 of each other the higher-value player now wins: a sure thing beats an equal-looking gamble.
    const scored = cands.map(c => ({ ...c, ...simulate(team, c, SIMS) })).sort((a, b) =>
      (Math.abs(b.p82 - a.p82) >= 0.01 ? b.p82 - a.p82 : 0) || (Math.abs(b.avg - a.avg) >= 0.5 ? b.avg - a.avg : b.v - a.v));
    const top = scored[0] || null;
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
    // Re-rolls are only worth spending to chase 82-0: never before 3 players are in place, and only while the team
    // picked so far can still reach the 82-0 score with the best remaining picks.
    const rerollOK = team.length >= 3 && reach !== null && reach >= SCORE_82;
    const rr = !rerollOK ? [] : [['Team', clubPool, 'team'], ['Era', eraPool, 'era']].filter(([, pl, key]) => pl.length && avail(key) !== false)
      .map(([name, pl, key]) => ({ name, n: pl.length, known: avail(key) === true, cost: costNote(key), ...simulate(team, { pool: pl }, SIMS) }));
    const out = reach !== null && reach < SCORE_82;
    const better = rr.filter(r => top && r.p82 - top.p82 >= 0.03).sort((a, b) => (b.p82 - a.p82) || (b.avg - a.avg))[0];

    // TOP BAR = what to do. Its colour rates the pick for its position: green = 82-0 calibre, blue = solid, amber = weak.
    // Re-roll advice uses the game's own button colours (orange team, purple era); RESTART is red.
    const bar = (bg, fg, head, sub) => `<div style="position:relative;background:${bg};color:${fg};border-radius:6px;padding:8px 34px 8px 10px;margin:-2px -3px 6px">${head}${sub ? `<div style="font:600 12px/1.35 system-ui,sans-serif;margin-top:3px">${sub}</div>` : ''}</div>`;
    const big = t => `<div style="font:800 19px/1.15 system-ui,sans-serif">${t}</div>`;
    // Grade = rank at the position the pick goes into, among every club/era stint in the known squads:
    // S top 10, A+ 11-25, A 26-50, B 51-100, C 101-200, D beyond. Same scale as the rank shown beside it.
    const tier = c => { const r = rankNum(c.p, placement(c).slot);
      return r <= 10 ? [GOLD, 'S'] : r <= 25 ? ['#047857', 'A+'] : r <= 50 ? ['#16a34a', 'A'] : r <= 100 ? ['#0e7490', 'B'] : r <= 200 ? ['#b45309', 'C'] : ['#b91c1c', 'D']; };
    const pickBar = c => { const pl = placement(c), [bg, word] = tier(c);
      const head = `<div style="font:800 11px/1.2 system-ui,sans-serif;letter-spacing:.06em;opacity:.85">${pl.moves.length ? 'MOVE FIRST, THEN TAKE' : 'TAKE'}</div>${big(`${esc(c.p.name)} <span style="font-weight:700;opacity:.9">&rarr; ${pl.slot}</span>`)}`;
      const sub = `${pl.moves.length ? `<b>First move ${pl.moves.join(', then ')}.</b><br>` : ''}${pl.keep.length ? `Needs ${pl.keep.join(', ')}.<br>` : ''}${c.v.toFixed(1)} &middot; ${posRank(c.p, pl.slot)}<span style="position:absolute;right:9px;bottom:6px;font:800 15px/1 system-ui,sans-serif" title="S top 10 ${pl.slot}, A+ top 25, A top 50, B top 100, C top 200, D beyond">(${word})</span>`;
      return bar(bg, '#fff', head, sub); };
    let top_ = '';
    const restart = team.length === 0 && top && !['S', 'A+', 'A'].includes(tier(top)[1]);
    if (!top) top_ = bar('#546e7a', '#fff', big('NOTHING TO PICK'), 'No player here can join your team in any arrangement.');
    else if (restart) top_ = bar('#991b1b', '#fff', big('RESTART THE GAME'), `Best here is ${esc(top.p.name)} &rarr; ${placement(top).slot}, ${top.v.toFixed(1)} (${tier(top)[1]}). A first pick outside the top 50 at his position leaves no realistic path.`);
    else if (better) { const era = better.name === 'Era';
      top_ = bar(era ? '#7c3aed' : '#f59e0b', era ? '#fff' : '#1a1a1a', big(`RE-ROLL ${better.name.toUpperCase()}`),
        `${better.known ? better.cost.replace(/^ \(|\)$/g, '') || 'Free re-roll available' : 'If you still have it'}. 82-0 chance ${pct(top.p82)} &rarr; ${pct(better.p82)}. Otherwise take ${esc(top.p.name)} &rarr; ${placement(top).slot}.`); }
    else top_ = pickBar(top);

    // OUTLOOK bar, below. Gold = a real 82-0 chance (1%+). Otherwise coloured by the projected record's grade.
    const chosen = better || top;
    let oddsHtml = '';
    if (chosen && !restart) {
      const w = winsFor(chosen.avg), g = gradeOf(w);
      const real = !out && chosen.p82 >= 0.01;
      const bg = real ? GOLD : g[3];
      // 82-0 marker: struck through once it's gone, ticked while still mathematically open, a percentage once it's real
      const mark = out ? '<s style="opacity:.75">82-0</s>' : real ? `82-0 ${pct(chosen.p82)}` : '82-0 &#10003;';
      const label = `Projected ${rec(chosen.avg)} &middot; ${g[1]} &middot; ${mark}`;
      oddsHtml = `<div style="background:${bg};border-radius:6px;padding:5px 9px;margin:0 -3px 6px;font:700 13px/1.3 system-ui,sans-serif">${label}</div>`;
    }
    // always on screen: the top 4 options. Behind (i): picks so far, re-roll lines, squad counts.
    let opts = '';
    for (const c of scored.slice(0, 4)) { const pl = placement(c);
      opts += `<div style="margin:1px 0">${c === top ? '\u2605 ' : ''}<b>${esc(c.p.name)}</b> &rarr; ${posRank(c.p, pl.slot)} &middot; ${c.v.toFixed(1)} &middot; ${rec(c.avg)}${c.p82 >= 0.01 ? ` &middot; 82-0 ${pct(c.p82)}` : ''}</div>`; }
    let h = `Picked: ${team.length ? SLOTS.filter(sl => picks[sl]).map(sl => `${sl} ${esc(picks[sl].name)} ${val(picks[sl]).toFixed(1)}`).join(', ') : 'none yet'}`;
    if (!rerollOK) h += `<br><small>Re-roll advice: ${team.length < 3 ? `only after 3 players are picked (${team.length} so far)` : '82-0 is no longer reachable with this team, so a re-roll would be wasted'}.</small>`;
    for (const r of rr) h += `<br>&nbsp; <span style="color:${r.name === 'Era' ? '#c4b5fd' : '#fcd34d'}">${r.name} re-roll</span>: <b>${pct(r.p82)}</b>, ${rec(r.avg)} <small>(${r.n} squads seen)</small>`;
    if (coins != null) h += `<br><small>Coins: ${coins} (${Math.floor(coins / COIN_COST)} re-roll${Math.floor(coins / COIN_COST) === 1 ? '' : 's'} at ${COIN_COST})</small>`;
    const none = ['team', 'era'].filter(k => avail(k) === false).map(k => k === 'team' ? 'Team' : 'Era');
    if (none.length) h += `<br><small>${none.length === 2 ? 'No re-rolls left' : none[0] + ' re-roll: none left'}${cell.boosters ? ' (per the game)' : ''}.</small>`;
    // machine-readable instruction (same decision as the top bar)
    let act;
    if (!top) act = { type: 'NONE' };
    else if (restart) act = { type: 'RESTART' };
    else { const pl = placement(top);
      const take = { name: top.p.name, slot: pl.slot, moves: pl.movesRaw || [] };
      act = better ? { type: better.name === 'Era' ? 'REROLL_ERA' : 'REROLL_TEAM', otherwise: take, cost: better.cost.replace(/^ \(|\)$/g, '') || 'free' } : { type: 'TAKE', ...take }; }
    const t = act.type === 'TAKE' ? act : act.otherwise;
    const takeStr = t ? `${t.moves.length ? 'MOVE|' + t.moves.map(m => `${m.name}>${m.to}`).join('|') + '|' : ''}TAKE|${t.name}|${t.slot}` : '';
    act.next = act.type === 'TAKE' ? takeStr : act.type.startsWith('REROLL') ? `${act.type}|${t.name}|${t.slot}` : act.type;
    act.open = SLOTS.filter(sl => !picks[sl]); act.p82 = (better || top)?.p82 ?? null; act.projected = top ? rec((better || top).avg) : null;
    cache = { sig, banner: top_ + oddsHtml, opts: restart ? '' : opts, h, rec: top, act };
    return cache;
  }

  // "?" view: how the game values players and teams (from the fitted model), applied to the current pick and team
  function explain() {
    const f = (x, d = 3) => (+x).toFixed(d), W = MODEL;
    const lines = [];
    lines.push(`<b>How 82-0 scores a team</b> <small>(worked out from ${W.GAMES} of your games; the game doesn't publish it)</small>`);
    lines.push(`<b>Player value</b> = ${f(W.ppg)} &times; PPG + ${f(W.rpg)} &times; RPG + ${f(W.apg)} &times; APG + ${f(W.spg)} &times; SPG + ${f(W.bpg)} &times; BPG`);
    lines.push(`<small>Steals and blocks count about 2&ndash;4&times; a point or assist. Players with no steals/blocks on record (1960s, early 1970s) get a flat +${f(W.NO_DEF, 2)} instead.</small>`);
    lines.push(`<b>Team score</b> = the five values ${W.BASE < 0 ? '&minus;' : '+'} ${f(Math.abs(W.BASE), 2)}, plus ${f(W.BPG_EXTRA, 2)} for each team block up to ${f(W.BPG_BEND, 1)} <small>(so a team short on blocks is penalised harder)</small>`);
    lines.push(`<b>Record</b> = 82 &times; (score &divide; 119.9)<sup>1.155</sup>, rounded. 82-0 needs a score of ${SCORE_82}.`);
    lines.push(`<b>Grades</b> rank a player against every club/era stint at that position: S top 10, A+ top 25, A top 50, B top 100, C top 200.`);
    const rec_ = cache?.rec;
    if (rec_ && cell) {
      const st = rec_.p.stats || {};
      const parts = STATS.map(k => st[k] == null ? null : `${(+st[k]).toFixed(1)} ${k.toUpperCase()} &times; ${f(W[k])} = <b>${(W[k] * st[k]).toFixed(1)}</b>`).filter(Boolean);
      if (st.spg == null && st.bpg == null) parts.push(`no steals/blocks on record = <b>+${f(W.NO_DEF, 1)}</b>`);
      lines.push(`<hr style="border:0;border-top:1px solid #456;margin:5px 0"><b>${esc(rec_.p.name)}</b>: ${parts.join(', ')} &rarr; value <b>${val(rec_.p).toFixed(1)}</b>`);
      const team = SLOTS.filter(sl => picks[sl]).map(sl => picks[sl]);
      if (team.length) {
        const withHim = [...team, rec_.p];
        const sumV = withHim.reduce((a, p) => a + val(p), 0), bb = blockBonus(withHim), blk = withHim.reduce((a, p) => a + bpgOf(p), 0);
        lines.push(`<b>Your team with him</b> (${withHim.length} of 5): values ${withHim.map(p => val(p).toFixed(1)).join(' + ')} = ${sumV.toFixed(1)}; blocks ${blk.toFixed(1)} &rarr; +${bb.toFixed(1)}. ${withHim.length === 5 ? `Score ${teamScore(withHim).toFixed(1)} = ${rec(teamScore(withHim))}.` : `Needs about ${(SCORE_82 - W.BASE - sumV - W.BPG_EXTRA * W.BPG_BEND).toFixed(1)} more from ${5 - withHim.length} player${5 - withHim.length > 1 ? 's' : ''} for 82-0 (with a full blocks bonus).`}`);
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
      const pred = teamScore(roster.map(r => r.player));
      resultRows = true;
      banner = BAN('#0b3d6b', '#fff', `RESULT ${esc(result.score_display?.name ?? '')}`, `Game score ${esc(result.score)} (model said ${pred.toFixed(1)}). ${esc(d.grade ?? '')} ${esc(d.grade_label ?? '')}`);
      body = roster.map(r => `${esc(r.slot)} <b>${esc(r.player?.name)}</b> &middot; ${posRank(r.player, r.slot)} &middot; ${val(r.player).toFixed(1)}`).join('<br>');
      body = `<div style="margin:2px 0 4px">${body}</div>`;
      publish(`RESULT|${d.wins ?? ''}-${d.losses ?? ''}|${result.score}`, { type: 'RESULT', wins: d.wins, losses: d.losses, score: result.score, model: +pred.toFixed(1), roster: roster.map(r => ({ slot: r.slot, name: r.player?.name })) });
    } else if (cell) { const a = advise(); banner = a.banner + (a.opts || ''); body = a.h;
      const usedIds = new Set(SLOTS.filter(sl => picks[sl]).map(sl => String(picks[sl].player_id)));
      const offer = (cell.squad || []).filter(p => !usedIds.has(String(p.player_id))).map(p => ({ name: p.name, positions: p.positions, value: +val(p).toFixed(2),
        ranks: Object.fromEntries((p.positions || []).filter(x => SLOTS.includes(x)).map(x => [x, rankNum(p, x)])) }));
      publish(a.act?.next || 'NONE', { ...(a.act || { type: 'NONE' }), club: cell.team?.abbr, era: cell.era, picked: SLOTS.filter(sl => picks[sl]).map(sl => ({ slot: sl, name: picks[sl].name })), offer });
    } else publish('WAIT', { type: 'WAIT' });
    if (!result && !cell) body = 'Waiting for the next spin or pick. Run this before your first spin so it can follow the whole game.';
    return { banner, body, resultRows };
  }

  // ---------- auto-driver controls ----------
  const DRIVER_URL = 'https://markjovic.github.io/82-0-tools/driver82.js';
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
    const what = driverLoading ? 'loading…' : running ? (st.mode === 'wilt' ? `hunting Wilt · ${st.restarts} restarts` : `auto · game ${st.games + 1}`) : st?.foundWilt ? '#1 C found: your turn' : st ? 'paused' : 'off';
    const coins = st?.coinsGained != null ? ` · +${st.coinsGained} coins` : '';
    return `<div style="margin:2px 0 5px;display:flex;align-items:center;gap:2px;flex-wrap:wrap"><small style="opacity:.75;margin-right:4px">Auto: ${what}${coins}</small>`
      + b('drv-auto', '&#9654; Auto', running && st.mode === 'advice', 'Play drafts by the overlay\'s advice')
      + b('drv-wilt', '&#127919; Wilt', running && st.mode === 'wilt', 'Hunt for the #1 C: S-grade picks only, C kept free, pauses when he appears')
      + (running ? b('drv-pause', '&#10074;&#10074; Pause', false, 'Pause the auto-driver') : '') + '</div>';
  };
  window.r82render = () => render();

  function render() {
    // hidden: a small round button where the panel was, visible on 82-0's dark page; tap it to bring the panel back
    if (mode === 'off') { compute(); P.style.cssText = `position:fixed;z-index:99999;${where()};width:30px;height:30px;border-radius:50%;background:#f59e0b;border:2px solid #fff;opacity:.75;cursor:pointer;touch-action:none;box-shadow:0 2px 8px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font:800 11px/1 system-ui,sans-serif;color:#1a1a1a`; P.innerHTML = '82'; return; }
    P.style.cssText = CSS_() + ';cursor:pointer';
    const ctl = `<div style="position:relative;z-index:3;float:right;margin:-2px -3px 2px 6px"><span data-r82="how" style="${BTN}${how ? ';background:rgba(255,255,255,.4)' : ''}" title="How players are valued">?</span><span data-r82="info" style="${BTN}${info ? ';background:rgba(255,255,255,.4)' : ''}" title="Details">i</span><span data-r82="off" style="${BTN}" title="Hide everything">&times;</span></div>`;
    const { banner, body, resultRows } = compute();
    const all = Object.keys({ ...SITE, ...LOG.squads }).length, onlyLocal = Object.keys(LOG.squads).filter(k => !SITE[k]).length;
    const foot = `<br><small>${all} squads in use (${Object.keys(SITE).length} shared${onlyLocal ? `, ${onlyLocal} new on this device` : ''})${siteNote ? ' &middot; ' + esc(siteNote) : ''}<br>${LOG.games.length} games, ${Object.keys(LOG.squads).length} squads logged &middot; <span data-r82="export" style="text-decoration:underline;cursor:pointer">export log</span>${note ? ' &middot; ' + esc(note) : ''}<br>82-0 overlay ${VERSION} &middot; model from ${MODEL.GAMES} games</small>`;
    const warn = siteNote && /NOT LOADED/.test(siteNote) ? `<small style="color:#ffb74d">${esc(siteNote)}</small>` : '';
    if (mode === 'min') P.innerHTML = banner || '<b>82-0 overlay</b>';
    else P.innerHTML = ctl + banner + driverBar() + (how ? `<div style="font-size:12px;line-height:1.45">${explain()}</div>` : info ? body + foot : (warn || (resultRows ? body : cell || result ? '' : body))) + (`<div style="font-size:10px;opacity:.55;margin-top:2px">tap to minimise &middot; drag to move &middot; ? how it works &middot; i details &middot; ${VERSION}</div>`);
  }

  const _fetch = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0]?.url || args[0] || '');
    const res = await _fetch(...args);
    if (/game-session\/api\/v\d+\/session\//.test(url)) {
      let body = null; try { body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : null; } catch (e) {}
      res.clone().json().then(j => {
        try {
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
            for (const e of lineup) { const p = byId.get(String(e.player_id)) || findPlayer(e); if (p && e.slot) np[e.slot] = p; }
            picks = np;
          }
          if (act?.type === 'pick_player' && cell) {
            const p = (cell.squad || []).find(x => String(x.player_id) === String(act.player_id) && String(x.team_id) === String(act.team_id));
            picks[act.slot] = p || { player_id: act.player_id, name: `#${act.player_id}`, stats: {} };
          }
          const bal = j?.user?.wallet?.balances;
          if (bal && bal.coin != null) { coins = +bal.coin; LOG.lastWallet = { at: new Date().toISOString(), balances: bal }; }
          if (j?.cell) {
            cell = j.cell; result = null;
            if (j.cell.seq === 0 && !act) { picks = {}; rerolls = { team: false, era: false }; seenStart = true; }
            LOG.squads[`${cell.team?.team_id}|${cell.era}`] = { team: cell.team, era: cell.era, squad: cell.squad };
            if (cell.boosters) LOG.lastBoosters = { at: new Date().toISOString(), legal: cell.legal, boosters: cell.boosters };
          }
          if (j && j.score != null && j.roster) {
            result = j;
            LOG.games.push({ at: new Date().toISOString(), game_id: j.game_id, score: j.score, display: j.score_display, mode: j.updated_stats?.game_mode,
              roster: j.roster.map(r => ({ slot: r.slot, player_id: r.player?.player_id, team_id: r.player?.team_id, era: r.player?.era, name: r.player?.name, positions: r.player?.positions, stats: r.player?.stats })) });
            picks = {}; rerolls = { team: false, era: false }; seenStart = false;
          }
          save(); render();
        } catch (e) { P.style.background = '#8b0000'; P.textContent = '82-0 overlay FAILED: ' + e.message; }
      }).catch(() => {});
    }
    return res;
  };
  render();
  _fetch(SQUADS_URL, { cache: 'default' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(j => { if (!j || typeof j.squads !== 'object') throw new Error('unexpected format'); SITE = j.squads; siteNote = ''; PAR = null; cache.sig = ''; render(); })
    .catch(e => { siteNote = 'SHARED SQUADS NOT LOADED (' + e.message + '); using this device only'; render(); });
})();
