// 82-0 overlay v1 (recorder), loaded by the r820 bookmarklet from markjovic.github.io/82-0-tools/overlay82.js
// Reads only what the game already sends this page during normal play (each spin's squad, your picks, the final
// result). It sends nothing to the game. Every finished game and every squad seen is logged in this browser so the
// server's scoring formula can be fitted later; until then, rankings are provisional and labelled as such.
(() => {
  if (window.r820) return;
  window.r820 = 1;
  const VERSION = 'v1';
  const LOG_KEY = 'r82log';
  const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const STATS = ['ppg', 'rpg', 'apg', 'spg', 'bpg'];
  // Provisional targets, published by a copycat site; NOT confirmed for 82-0.com. Used only to order candidates.
  const TARGET = { ppg: 122, rpg: 44, apg: 27, spg: 7.2, bpg: 4.6 };
  const NEED_GAMES = 30;     // games logged before fitting the formula is worth trying

  // ---------- log (persists in this browser) ----------
  const load = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY)) || { games: [], squads: {}, actions: {} }; } catch (e) { return { games: [], squads: {}, actions: {} }; } };
  let LOG = load();
  const save = () => { try { localStorage.setItem(LOG_KEY, JSON.stringify(LOG)); } catch (e) { status = 'LOG NOT SAVED: ' + e.message; } };

  // ---------- live state, built from the game's own requests and replies ----------
  let cell = null;          // current spin: {era, team, squad}
  let picks = {};           // slot -> player
  let result = null;        // final reply
  let status = 'Waiting for the next spin or pick (the overlay sees the game from its next request).';

  const P = document.createElement('div');
  const CSS = 'position:fixed;right:6px;bottom:88px;z-index:99999;background:#0b2545;color:#fff;border-radius:8px;padding:7px 9px;font:12px/1.4 system-ui,sans-serif;max-width:320px;max-height:62vh;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,.35)';
  P.style.cssText = CSS;
  document.body.append(P);
  let mode = 'full';
  const BTN = 'display:inline-block;min-width:22px;text-align:center;padding:1px 6px;margin-left:4px;border-radius:5px;background:rgba(255,255,255,.18);color:#fff;font:700 13px/1.4 system-ui,sans-serif;cursor:pointer';
  P.addEventListener('click', e => {
    const m = e.target.closest && e.target.closest('[data-r82]');
    if (m) { const a = m.getAttribute('data-r82'); if (a === 'export') exportLog(); else mode = a; e.stopPropagation(); render(); }
    else if (mode === 'off') { mode = 'full'; render(); }
  });

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  const totals = ps => { const t = Object.fromEntries(STATS.map(k => [k, 0])); for (const p of ps) for (const k of STATS) t[k] += n(p?.stats?.[k]); return t; };
  // provisional impact: share of each target, capped at the target, summed
  const impact = (p, base) => STATS.reduce((a, k) => a + Math.min(1, (base[k] + n(p.stats?.[k])) / TARGET[k]) - Math.min(1, base[k] / TARGET[k]), 0);
  const fmtStats = s => STATS.map(k => `${k.slice(0, 3).toUpperCase()} ${s?.[k] == null ? '-' : (+s[k]).toFixed(1)}`).join(' ');

  function exportLog() {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: VERSION, ...LOG })], { type: 'application/json' })), download: '82-0-log.json' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  function render() {
    if (mode === 'off') { P.style.cssText = 'position:fixed;right:2px;bottom:50%;z-index:99999;width:12px;height:12px;border-radius:50%;background:#0b2545;opacity:.3;cursor:pointer'; P.innerHTML = ''; return; }
    P.style.cssText = CSS;
    const ctl = `<div style="float:right;margin:-2px -3px 2px 6px">${mode === 'full' ? `<span data-r82="min" style="${BTN}">&minus;</span>` : `<span data-r82="full" style="${BTN}">+</span>`}<span data-r82="off" style="${BTN}">&times;</span></div>`;
    const games = LOG.games.length, pools = Object.keys(LOG.squads).length;
    const banner = `<div style="background:#455a64;border-radius:6px;padding:7px 9px;margin:-2px -3px 6px;font:800 14px/1.2 system-ui,sans-serif">RECORDING &middot; ${games}/${NEED_GAMES} games<div style="font:600 12px/1.3 system-ui,sans-serif;margin-top:3px">No advice yet: 82-0 scores on its server. Logging your games so the formula can be fitted. Rankings below are provisional.</div></div>`;
    let z = '';
    if (result) {
      const d = result.score_display?.detail || {};
      z += `<b>Result ${esc(result.score_display?.name ?? '')}</b> &middot; score ${esc(result.score)} &middot; ${esc(d.grade ?? '')} ${esc(d.grade_label ?? '')}<br><small>Logged as game ${games}.</small>`;
    } else if (cell) {
      const placed = SLOTS.filter(s => picks[s]), open = SLOTS.filter(s => !picks[s]);
      const base = totals(placed.map(s => picks[s]));
      z += `<b>${esc(cell.team?.abbr)} ${esc(cell.era)}</b> &middot; open: ${open.join(', ') || 'none'}`;
      if (placed.length) z += `<br><small>Team so far: ${fmtStats(base)}</small>`;
      for (const s of open) {
        const c = (cell.squad || []).filter(p => (p.positions || []).includes(s)).map(p => ({ p, v: impact(p, base) })).sort((a, b) => b.v - a.v).slice(0, 3);
        z += `<br><b>${s}</b>: ${c.length ? c.map((x, i) => `${i ? '' : '<b>'}${esc(x.p.name)}${i ? '' : '</b>'}`).join(', ') : 'none'}`;
        if (c[0] && mode === 'full') z += `<br><small>&nbsp; ${fmtStats(c[0].p.stats)}</small>`;
      }
    } else z += esc(status);
    if (mode === 'full') z += `<br><small>${games} games, ${pools} club/era squads logged &middot; <span data-r82="export" style="text-decoration:underline;cursor:pointer">export log</span><br>82-0 overlay ${VERSION}</small>`;
    P.innerHTML = ctl + banner + (mode === 'full' ? z : '');
  }

  // ---------- watch the game's own traffic (no requests of our own) ----------
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
          if (act && act.type !== 'pick_player' && !j?.cell) status = `Saw action "${act.type}"`;
          save(); render();
        } catch (e) { P.style.background = '#8b0000'; P.textContent = '82-0 overlay FAILED: ' + e.message; }
      }).catch(() => {});
    }
    return res;
  };
  render();
})();
