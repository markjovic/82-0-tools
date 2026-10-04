// 82-0 overlay v2, loaded by the r820 bookmarklet from markjovic.github.io/82-0-tools/overlay82.js
// Reads only what the game already sends this page during normal play (each spin's squad, your picks, the final
// result) and sends nothing to the game. Scoring model fitted from 31 logged games (see MODEL); every finished game
// keeps being logged so the model can be re-checked.
(() => {
  if (window.r820) return;
  window.r820 = 1;
  const VERSION = 'v3';
  const LOG_KEY = 'r82log';
  const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const STATS = ['ppg', 'rpg', 'apg', 'spg', 'bpg'];
  // Refitted 5 Oct 2026 from 37 games (scores 69.8-106.8): team score = sum of player values + BASE.
  // A player with no steals/blocks on record (1960s, early 1970s) gets NO_DEF instead. Leave-one-out error about 0.4.
  const MODEL = { ppg: 0.353, rpg: 0.623, apg: 0.571, spg: 1.382, bpg: 1.529, NO_DEF: 2.738, BASE: -2.096, GAMES: 37 };
  // Score to wins: matched all 37 games exactly. 82 wins needs a score of about 120 (beyond the highest seen, 106.8).
  const winsFor = s => Math.max(0, Math.min(82, Math.round(0.751 * s - 8.70)));
  const SCORE_82 = 120.05;
  const SIMS = 800;

  // ---------- log ----------
  const load = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY)) || { games: [], squads: {}, actions: {} }; } catch (e) { return { games: [], squads: {}, actions: {} }; } };
  let LOG = load();
  let note = '';
  const save = () => { try { localStorage.setItem(LOG_KEY, JSON.stringify(LOG)); } catch (e) { note = 'LOG NOT SAVED: ' + e.message; } };

  // ---------- model ----------
  const val = p => { const s = p?.stats || {}; return STATS.reduce((a, k) => a + MODEL[k] * (+s[k] || 0), 0) + (s.spg == null && s.bpg == null ? MODEL.NO_DEF : 0); };
  const fits = (p, s) => (p.positions || []).includes(s);
  const squads = () => Object.values(LOG.squads).filter(q => q.squad?.length);
  let PAR = null, parN = 0;
  const par = () => {   // average best value a random squad offers at each position
    const qs = squads(); if (PAR && parN === qs.length) return PAR;
    PAR = {}; parN = qs.length;
    for (const s of SLOTS) { const v = qs.map(q => Math.max(0, ...q.squad.filter(p => fits(p, s)).map(val))).filter(x => x > 0); PAR[s] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 15; }
    return PAR;
  };
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const bestPlace = (squad, open, used) => { let b = null; const pr = par();
    for (const p of squad) { if (used.has(String(p.player_id))) continue; const v = val(p);
      for (const s of open) if (fits(p, s)) { const sc = v - pr[s]; if (!b || sc > b.sc) b = { p, s, v, sc }; } }
    return b; };
  // first: {p, s} = take that player now; {pool: [...squads]} = re-roll into one of those squads
  function simulate(base, open, used, first, sims) {
    const qs = squads(); let hit = 0, tot = 0;
    for (let n = 0; n < sims; n++) {
      const o = new Set(open), u = new Set(used); let sum = base;
      const place = sq => { const b = bestPlace(sq, o, u); if (!b) return false; o.delete(b.s); u.add(String(b.p.player_id)); sum += b.v; return true; };
      let ok;
      if (first.p) { o.delete(first.s); u.add(String(first.p.player_id)); sum += val(first.p); ok = true; }
      else ok = first.pool.length ? place(rnd(first.pool).squad) : false;
      let guard = 0;
      while (ok && o.size && guard++ < 40) { const sq = rnd(qs).squad; if (!bestPlace(sq, o, u)) continue; place(sq); }
      const score = sum + MODEL.BASE; tot += score; if (score >= SCORE_82) hit++;
    }
    return { p82: hit / sims, avg: tot / sims };
  }
  // best team still reachable from the squads seen so far (upper bound for "out of reach")
  function maxReach(base, open, used) {
    const qs = squads(), cands = {};
    for (const s of open) cands[s] = qs.flatMap(q => q.squad).filter(p => fits(p, s) && !used.has(String(p.player_id))).map(p => [val(p), p]).sort((a, b) => b[0] - a[0]).slice(0, 12);
    let best = -Infinity; const sl = [...open], u = new Set(used);
    const rec = (i, sum) => { if (i === sl.length) { best = Math.max(best, sum); return; }
      for (const [v, p] of cands[sl[i]]) { if (sum + v + (sl.length - i - 1) * 40 <= best) break; const id = String(p.player_id); if (u.has(id)) continue; u.add(id); rec(i + 1, sum + v); u.delete(id); } };
    rec(0, base); return best === -Infinity ? null : best + MODEL.BASE;
  }

  // ---------- live state from the game's own traffic ----------
  let cell = null, picks = {}, result = null, cache = { sig: '', html: '', rec: null };
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
    const placed = SLOTS.filter(s => picks[s]), open = SLOTS.filter(s => !picks[s]);
    const used = new Set(placed.map(s => String(picks[s].player_id)));
    const base = placed.reduce((a, s) => a + val(picks[s]), 0);
    const sig = placed.map(s => s + picks[s].player_id).join() + '|' + cell.team?.team_id + cell.era + '|' + squads().length;
    if (sig === cache.sig) return cache;
    const squad = cell.squad || [];
    const cands = []; for (const s of open) squad.filter(p => fits(p, s) && !used.has(String(p.player_id))).map(p => ({ p, s, v: val(p) })).sort((a, b) => b.v - a.v).slice(0, 2).forEach(c => cands.push(c));
    const scored = cands.map(c => ({ ...c, ...simulate(base, open, used, c, SIMS) })).sort((a, b) => b.p82 - a.p82 || b.avg - a.avg);
    const top = scored[0] || null;
    const qs = squads();
    const clubPool = qs.filter(q => q.era === cell.era && q.team?.team_id !== cell.team?.team_id);
    const eraPool = qs.filter(q => q.team?.team_id === cell.team?.team_id && q.era !== cell.era);
    const rr = [['Team', clubPool], ['Era', eraPool]].filter(([, pl]) => pl.length).map(([name, pl]) => ({ name, n: pl.length, ...simulate(base, open, used, { pool: pl }, SIMS) }));
    const reach = maxReach(base, open, used);
    let banner, h = '';
    const better = rr.filter(r => top && (r.p82 - top.p82 >= 0.03 || (top.p82 < 0.005 && r.avg - top.avg >= 1.5))).sort((a, b) => (b.p82 - a.p82) || (b.avg - a.avg))[0];
    if (!top) banner = BAN('#546e7a', '#fff', 'NOTHING TO PICK', 'No player here fits an open position.');
    else if (better) banner = BAN(better.name === 'Era' ? '#7c3aed' : '#f59e0b', better.name === 'Era' ? '#fff' : '#1a1a1a', `RE-ROLL ${better.name.toUpperCase()}`,
      top.p82 >= 0.005 ? `82-0 chance: ${pct(top.p82)} picking now, ${pct(better.p82)} after the ${better.name.toLowerCase()} re-roll (if you still have it).` : `Projected record: ${rec(top.avg)} picking now, ${rec(better.avg)} after the ${better.name.toLowerCase()} re-roll (if you still have it).`);
    else if (reach !== null && reach < SCORE_82) banner = BAN('#c62828', '#fff', '82-0 OUT OF REACH', `Best possible from here is ${rec(reach)} (from the squads seen so far). Best pick for your record: ${esc(top.p.name)} at ${top.s}, projected ${rec(top.avg)}.`);
    else banner = BAN('#15803d', '#fff', `TAKE ${esc(top.p.name.toUpperCase())} AT ${top.s}`, `Value ${top.v.toFixed(1)}. 82-0 chance ${pct(top.p82)}; projected ${rec(top.avg)}.`);
    h += `<b>${esc(cell.team?.abbr)} ${esc(cell.era)}</b> &middot; open: ${open.join(', ')}`;
    if (placed.length) h += `<br>Team so far: ${placed.map(s => `${s} ${val(picks[s]).toFixed(1)}`).join(', ')} (score ${(base + MODEL.BASE).toFixed(1)} before the rest)`;
    h += `<br>Choices (82-0 chance, projected record):`;
    for (const c of scored.slice(0, 5)) h += `<br>&nbsp; ${c === top ? '\u2605\u2605 ' : ''}${esc(c.p.name)} at ${c.s} (${c.v.toFixed(1)}): <b>${pct(c.p82)}</b>, ${rec(c.avg)}`;
    for (const r of rr) h += `<br>&nbsp; <span style="color:${r.name === 'Era' ? '#c4b5fd' : '#fcd34d'}">${r.name} re-roll</span>: <b>${pct(r.p82)}</b>, ${rec(r.avg)} <small>(${r.n} squads seen)</small>`;
    cache = { sig, banner, h, rec: top };
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
    const foot = `<br><small>${LOG.games.length} games, ${Object.keys(LOG.squads).length} squads logged &middot; <span data-r82="export" style="text-decoration:underline;cursor:pointer">export log</span>${note ? ' &middot; ' + esc(note) : ''}<br>82-0 overlay ${VERSION} &middot; model from ${MODEL.GAMES} games</small>`;
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
          if (/session\/start/.test(url)) { picks = {}; cell = null; result = null; }
          const act = body?.action;
          if (act?.type) LOG.actions[act.type] = (LOG.actions[act.type] || 0) + 1;
          if (act?.type && act.type !== 'pick_player') LOG.actionSamples = { ...(LOG.actionSamples || {}), [act.type]: act };
          if (act?.type === 'pick_player' && cell) {
            const p = (cell.squad || []).find(x => String(x.player_id) === String(act.player_id) && String(x.team_id) === String(act.team_id));
            picks[act.slot] = p || { player_id: act.player_id, name: `#${act.player_id}`, stats: {} };
          }
          if (j?.cell) {
            cell = j.cell; result = null;
            if (j.cell.seq === 0 && !act) picks = {};
            LOG.squads[`${cell.team?.team_id}|${cell.era}`] = { team: cell.team, era: cell.era, squad: cell.squad };
          }
          if (j && j.score != null && j.roster) {
            result = j;
            LOG.games.push({ at: new Date().toISOString(), game_id: j.game_id, score: j.score, display: j.score_display, mode: j.updated_stats?.game_mode,
              roster: j.roster.map(r => ({ slot: r.slot, player_id: r.player?.player_id, team_id: r.player?.team_id, era: r.player?.era, name: r.player?.name, positions: r.player?.positions, stats: r.player?.stats })) });
            picks = {};
          }
          save(); render();
        } catch (e) { P.style.background = '#8b0000'; P.textContent = '82-0 overlay FAILED: ' + e.message; }
      }).catch(() => {});
    }
    return res;
  };
  render();
})();
