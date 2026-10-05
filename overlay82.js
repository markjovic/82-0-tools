// 82-0 overlay v2, loaded by the r820 bookmarklet from markjovic.github.io/82-0-tools/overlay82.js
// Reads only what the game already sends this page during normal play (each spin's squad, your picks, the final
// result) and sends nothing to the game. Scoring model fitted from 31 logged games (see MODEL); every finished game
// keeps being logged so the model can be re-checked.
(() => {
  if (window.r820) return;
  window.r820 = 1;
  const VERSION = 'v12';
  const LOG_KEY = 'r82log';
  const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const STATS = ['ppg', 'rpg', 'apg', 'spg', 'bpg'];
  // Refitted 5 Oct 2026 from 87 games (scores 69.8-112.0); leave-one-out error 0.54, no sign of curvature: team score = sum of player values + BASE.
  // A player with no steals/blocks on record (1960s, early 1970s) gets NO_DEF instead.
  const MODEL = { ppg: 0.345, rpg: 0.613, apg: 0.621, spg: 1.253, bpg: 1.515, NO_DEF: 2.946, BASE: -1.262, GAMES: 87 };
  // Score to wins: a power curve that matches all 87 games exactly (a straight line missed the 102.7 game).
  // 82 wins needs a score between 119.27 and 119.36 (narrowed by the 112.0 game); the upper end is used.
  const winsFor = s => Math.max(0, Math.min(82, Math.round(82 * Math.pow(Math.max(0, s) / 119.9, 1.155))));
  const SCORE_82 = 119.36;
  const SIMS = 800;
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
  // Players can be moved between positions after they're picked, so a team is a SET of players that only needs
  // some valid arrangement. assign() finds one, keeping each player in his current position where it can.
  const assign = (players, cur) => {
    const order = [...players].sort((a, b) => (a.positions || []).length - (b.positions || []).length);
    const res = {};
    const bt = i => { if (i === order.length) return true; const p = order[i], pref = cur?.get(String(p.player_id));
      const opts = [...(pref ? [pref] : []), ...(p.positions || []).filter(x => x !== pref && SLOTS.includes(x))];
      for (const sl of opts) if (!res[sl] && fits(p, sl)) { res[sl] = p; if (bt(i + 1)) return true; delete res[sl]; }
      return false; };
    return bt(0) ? res : null;
  };
  const feasible = players => players.length <= 5 && assign(players) !== null;
  // best addition from a squad: the highest-value player who still leaves a valid arrangement
  const bestAdd = (squad, team, used) => { let b = null;
    for (const p of squad) { if (used.has(String(p.player_id))) continue; const v = val(p); if (b && v <= b.v) continue;
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
      const score = sum + MODEL.BASE; tot += score; if (score >= SCORE_82) hit++;
    }
    return { p82: hit / sims, avg: tot / Math.max(1, sims) };
  }
  // best team still reachable from the squads seen so far (upper bound for "out of reach")
  function maxReach(team) {
    const used = new Set(team.map(p => String(p.player_id)));
    const pool = squads().flatMap(q => q.squad).filter(p => !used.has(String(p.player_id))).map(p => [val(p), p]).sort((a, b) => b[0] - a[0]).slice(0, 80);
    const need = 5 - team.length; let best = -Infinity;
    const rec = (i, t, sum, k) => {
      if (k === need) { best = Math.max(best, sum); return; }
      for (let j = i; j < pool.length; j++) { const [v, p] = pool[j]; if (sum + v * (need - k) <= best) break;
        if (t.some(x => String(x.player_id) === String(p.player_id))) continue;
        const nt = [...t, p]; if (!feasible(nt)) continue; rec(j + 1, nt, sum + v, k + 1); } };
    rec(0, team, team.reduce((a, p) => a + val(p), 0), 0);
    return best === -Infinity ? null : best + MODEL.BASE;
  }

  // ---------- live state from the game's own traffic ----------
  let cell = null, picks = {}, result = null, cache = { sig: '', html: '', rec: null };
  // re-rolls used this game; seenStart = the overlay saw this game from its first spin, so 'unused' is known
  let rerolls = { team: false, era: false }, seenStart = false;
  const P = document.createElement('div');
  const CSS = 'position:fixed;right:6px;bottom:88px;z-index:99999;background:#0b2545;color:#fff;border-radius:8px;padding:7px 9px;font:12px/1.4 system-ui,sans-serif;max-width:320px;max-height:62vh;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,.35)';
  P.style.cssText = CSS; document.body.append(P);
  let mode = 'full';
  const BTN = 'display:inline-block;min-width:22px;text-align:center;padding:1px 6px;margin-left:4px;border-radius:5px;background:rgba(255,255,255,.18);color:#fff;font:700 13px/1.4 system-ui,sans-serif;cursor:pointer';
  P.addEventListener('click', e => {
    const m = e.target.closest && e.target.closest('[data-r82]');
    if (m) { const a = m.getAttribute('data-r82'); if (a === 'export') exportLog(); else mode = a; e.stopPropagation(); render(); }
    else if (mode === 'off') { mode = 'full'; render(); }
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
    const sig = SLOTS.map(sl => sl + (picks[sl]?.player_id || '')).join() + '|' + cell.team?.team_id + cell.era + '|' + squads().length + '|' + rerolls.team + rerolls.era + '|' + JSON.stringify(cell.boosters || null);
    if (sig === cache.sig) return cache;
    // candidates: every player on this spin who can join the team in some arrangement, best values first
    const cands = (cell.squad || []).filter(p => !used.has(String(p.player_id)) && feasible([...team, p])).map(p => ({ p, v: val(p) })).sort((a, b) => b.v - a.v).slice(0, 6);
    const scored = cands.map(c => ({ ...c, ...simulate(team, c, SIMS) })).sort((a, b) => b.p82 - a.p82 || b.avg - a.avg);
    const top = scored[0] || null;
    // where the pick goes, and which already-picked players have to move to make room
    const placement = c => { const a = assign([...team, c.p], cur) || {}; const slot = SLOTS.find(sl => a[sl] === c.p);
      const moves = SLOTS.filter(sl => a[sl] && a[sl] !== c.p && cur.get(String(a[sl].player_id)) !== sl).map(sl => `move ${esc(a[sl].name)} ${cur.get(String(a[sl].player_id))} to ${sl}`);
      return { slot, moves }; };
    const qs = squads();
    const clubPool = qs.filter(q => q.era === cell.era && q.team?.team_id !== cell.team?.team_id);
    const eraPool = qs.filter(q => q.team?.team_id === cell.team?.team_id && q.era !== cell.era);
    // Re-roll availability comes from the game itself: each spin lists its boosters with how many uses are left.
    const boost = key => cell.boosters?.['respin_' + key];
    const avail = key => { const b = boost(key); if (!b) return !rerolls[key] ? null : false;
      return !!(b.enabled && (b.next_use && b.next_use !== 'none') && ((+b.remaining || 0) > 0 || (+b.free_left || 0) > 0 || (+b.rv_left || 0) > 0)); };
    const costNote = key => { const b = boost(key); return b && b.next_use && !['free', 'none'].includes(b.next_use) ? ` (costs: ${b.next_use === 'rv' ? 'watch an ad' : b.next_use})` : ''; };
    const reach = maxReach(team);
    // Re-rolls are only worth spending to chase 82-0: never before 3 players are in place, and only while the team
    // picked so far can still reach the 82-0 score with the best remaining picks.
    const rerollOK = team.length >= 3 && reach !== null && reach >= SCORE_82;
    const rr = !rerollOK ? [] : [['Team', clubPool, 'team'], ['Era', eraPool, 'era']].filter(([, pl, key]) => pl.length && avail(key) !== false)
      .map(([name, pl, key]) => ({ name, n: pl.length, known: avail(key) === true, cost: costNote(key), ...simulate(team, { pool: pl }, SIMS) }));
    const out = reach !== null && reach < SCORE_82;
    const better = rr.filter(r => top && r.p82 - top.p82 >= 0.03).sort((a, b) => (b.p82 - a.p82) || (b.avg - a.avg))[0];

    // TOP BAR = what to do. Blue = take a player; orange/purple = use that re-roll (the game's own button colours).
    let top_ = '';
    const bar = (bg, fg, head, sub) => `<div style="background:${bg};color:${fg};border-radius:6px;padding:8px 10px;margin:-2px -3px 6px">${head}${sub ? `<div style="font:600 12px/1.35 system-ui,sans-serif;margin-top:3px">${sub}</div>` : ''}</div>`;
    const pickHead = c => { const pl = placement(c);
      return { head: `<div style="font:800 11px/1.2 system-ui,sans-serif;letter-spacing:.06em;opacity:.85">TAKE</div><div style="font:800 19px/1.15 system-ui,sans-serif">${esc(c.p.name)} <span style="font-weight:700;opacity:.9">&rarr; ${pl.slot}</span></div>`,
        sub: `plays ${(c.p.positions || []).join(' / ')} &middot; value ${c.v.toFixed(1)}${pl.moves.length ? `<br><b>Then ${pl.moves.join('; ')}.</b>` : ''}` }; };
    if (!top) top_ = bar('#546e7a', '#fff', '<div style="font:800 17px/1.2 system-ui,sans-serif">NOTHING TO PICK</div>', 'No player here can join your team in any arrangement.');
    else if (better) { const era = better.name === 'Era', ph = pickHead(top);
      top_ = bar(era ? '#7c3aed' : '#f59e0b', era ? '#fff' : '#1a1a1a', `<div style="font:800 19px/1.15 system-ui,sans-serif">RE-ROLL ${better.name.toUpperCase()}</div>`,
        `${better.known ? better.cost.replace(/^ \(|\)$/g, '') || 'Free re-roll available' : 'If you still have it'}. Otherwise take ${esc(top.p.name)} &rarr; ${placement(top).slot}.`); }
    else { const ph = pickHead(top); top_ = bar('#1d4ed8', '#fff', ph.head, ph.sub); }

    // ODDS, below the pick. Colour shows the 82-0 outlook: green = real chance (10%+), amber = long shot, red = none.
    const chosen = better || top;
    let oddsHtml = '';
    if (chosen) {
      const p82 = chosen.p82, oc = out || p82 < 0.005 ? '#c62828' : p82 < 0.10 ? '#b45309' : '#15803d';
      const label = out ? `82-0 out of reach: best possible ${rec(reach)}` : p82 < 0.005 ? '82-0 chance under 1%' : `82-0 chance ${pct(p82)}`;
      oddsHtml = `<div style="background:${oc};border-radius:6px;padding:5px 9px;margin:0 -3px 6px;font:700 13px/1.3 system-ui,sans-serif">${label} &middot; projected ${rec(chosen.avg)}</div>`;
    }
    let h = `Picked: ${team.length ? SLOTS.filter(sl => picks[sl]).map(sl => `${sl} ${esc(picks[sl].name)} ${val(picks[sl]).toFixed(1)}`).join(', ') : 'none yet'}`;
    h += `<br>Choices (82-0 chance, projected record):`;
    for (const c of scored.slice(0, 5)) { const pl = placement(c); h += `<br>&nbsp; ${c === top ? '\u2605\u2605 ' : ''}${esc(c.p.name)} &rarr; ${pl.slot}${pl.moves.length ? ' (with a move)' : ''} (${c.v.toFixed(1)}): <b>${pct(c.p82)}</b>, ${rec(c.avg)}`; }
    if (!rerollOK) h += `<br><small>Re-roll advice: ${team.length < 3 ? `only after 3 players are picked (${team.length} so far)` : '82-0 is no longer reachable with this team, so a re-roll would be wasted'}.</small>`;
    for (const r of rr) h += `<br>&nbsp; <span style="color:${r.name === 'Era' ? '#c4b5fd' : '#fcd34d'}">${r.name} re-roll</span>: <b>${pct(r.p82)}</b>, ${rec(r.avg)} <small>(${r.n} squads seen)</small>`;
    const none = ['team', 'era'].filter(k => avail(k) === false).map(k => k === 'team' ? 'Team' : 'Era');
    if (none.length) h += `<br><small>${none.length === 2 ? 'No re-rolls left' : none[0] + ' re-roll: none left'}${cell.boosters ? ' (per the game)' : ''}.</small>`;
    cache = { sig, banner: top_ + oddsHtml, h, rec: top };
    return cache;
  }

  function render() {
    if (mode === 'off') { P.style.cssText = 'position:fixed;right:2px;bottom:50%;z-index:99999;width:12px;height:12px;border-radius:50%;background:#0b2545;opacity:.3;cursor:pointer'; P.innerHTML = ''; return; }
    P.style.cssText = CSS;
    const ctl = `<div style="float:right;margin:-2px -3px 2px 6px">${mode === 'full' ? `<span data-r82="min" style="${BTN}">&minus;</span>` : `<span data-r82="full" style="${BTN}">+</span>`}<span data-r82="off" style="${BTN}">&times;</span></div>`;
    let banner = '', body = '';
    if (result) {
      const d = result.score_display?.detail || {}, roster = result.roster || [];
      const pred = roster.reduce((a, r) => a + val(r.player), 0) + MODEL.BASE;
      banner = BAN('#0b3d6b', '#fff', `RESULT ${esc(result.score_display?.name ?? '')}`, `Game score ${esc(result.score)} (model said ${pred.toFixed(1)}). ${esc(d.grade ?? '')} ${esc(d.grade_label ?? '')}`);
      body = roster.map(r => `${esc(r.slot)} ${esc(r.player?.name)} ${val(r.player).toFixed(1)}`).join('<br>');
    } else if (cell) { const a = advise(); banner = a.banner; body = a.h; }
    else body = 'Waiting for the next spin or pick. Run this before your first spin so it can follow the whole game.';
    const all = Object.keys({ ...SITE, ...LOG.squads }).length, onlyLocal = Object.keys(LOG.squads).filter(k => !SITE[k]).length;
    const foot = `<br><small>${all} squads in use (${Object.keys(SITE).length} shared${onlyLocal ? `, ${onlyLocal} new on this device` : ''})${siteNote ? ' &middot; ' + esc(siteNote) : ''}<br>${LOG.games.length} games, ${Object.keys(LOG.squads).length} squads logged &middot; <span data-r82="export" style="text-decoration:underline;cursor:pointer">export log</span>${note ? ' &middot; ' + esc(note) : ''}<br>82-0 overlay ${VERSION} &middot; model from ${MODEL.GAMES} games</small>`;
    P.innerHTML = ctl + banner + (mode === 'full' ? body + foot : '');
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
  _fetch(SQUADS_URL, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(j => { if (!j || typeof j.squads !== 'object') throw new Error('unexpected format'); SITE = j.squads; siteNote = ''; PAR = null; cache.sig = ''; render(); })
    .catch(e => { siteNote = 'SHARED SQUADS NOT LOADED (' + e.message + '); using this device only'; render(); });
})();
