// 82-0 auto-driver: plays Classic drafts by following the overlay's instruction (window.r820.next), clicking the
// page itself. No AI round-trips, so a pick takes a few seconds instead of 10-15.
// Needs overlay v30+. Never re-rolls, never uses any booster, never spends coins, never watches ads.
// Stop at any time with:  r82stop()      Status: the small box at the top-left of the page.
(async () => {
  if (window.r82drv) { console.log('driver already running'); return; }
  window.r82drv = true;

  // ---------- settings ----------
  const MAX_GAMES  = 30;     // stop after this many finished games
  const MAX_RESTARTS = 400;  // Wilt hunt: stop after this many abandoned drafts
  // mode: 'advice' plays every draft by the overlay's advice; 'wilt' hunts for the #1 C (Wilt Chamberlain, PHI 1960s):
  // keeps C free, takes only S-grade (top 10) players elsewhere, abandons any draft with no S-grade player on offer,
  // and pauses for you the moment the #1 C appears.
  let MODE = window.r82mode === 'wilt' ? 'wilt' : 'advice';
  // caps apply per batch: when one is reached the driver stops, and pressing Resume / Auto / Wilt starts a new batch
  let gamesEnd = MAX_GAMES, restartsEnd = MAX_RESTARTS;
  let finishAfterGame = false;
  // Wilt hunt: once a draft has 2 S-grade picks it is kept and played to the end on the overlay's advice (for the
  // coins), still pausing if the #1 C turns up. sPicks counts S-grade picks in the current draft.
  const KEEP_AFTER_S = 2;
  // Auto plays every draft to the end instead of quitting weak ones: quitting has twice reloaded the whole page
  // (which stops the driver), and a full game still earns coins and adds data. The Wilt hunt still quits.
  const AUTO_QUITS = false;
  const HUNT_TOP_C = 2;   // pause when a C ranked this high or better is on offer: #1 and #2 are both Wilt (SFW and PHI 1960s)
  let sPicks = 0;
  const GAP_MS     = 700;    // pause between actions (human pace; don't go much lower)
  const COURT_MS   = 1700;   // the court slides in after a player is selected; clicks before this are ignored
  const SEQ_WAIT   = 9000;   // how long to wait for the overlay to confirm an action registered
  const DRY_RUN    = !!window.r82dry;  // set window.r82dry = true before loading to outline targets without clicking

  const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // When the tab is hidden or fully covered by another window, the browser freezes the game's animations and slows
  // timers, so nothing the driver waits for can happen. Pause until the page is visible again instead of failing.
  const hidden = () => document.visibilityState === 'hidden';
  const whileHidden = async () => { if (!hidden()) return false;
    say('paused: the game tab is hidden or covered; resumes when it\'s visible');
    while (hidden() && !stopped) await sleep(500);
    if (!stopped) { say('resumed'); await sleep(1500); }   // let the game catch up on its animations
    return true; };
  let stopped = false, games = 0, picks = 0, restarts = 0, skippedRerolls = 0, rerollsUsed = 0;
  const marker = document.createElement('div'); document.body.append(marker);
  const log = [];
  // ---------- persistent run log (survives reloads; included in the overlay's "export log") ----------
  const RUN_KEY = 'r82drvlog', RUN_MAX = 1500;
  let runLog = []; try { runLog = JSON.parse(localStorage.getItem(RUN_KEY)) || []; } catch (e) {}
  const persist = (ev, extra) => {
    runLog.push({ t: new Date().toISOString(), ev, mode: typeof MODE === 'undefined' ? null : MODE, next: window.r820?.next ?? null, seq: window.r820?.seq ?? null,
      vis: document.visibilityState, focus: document.hasFocus?.() ?? null, ...extra });
    if (runLog.length > RUN_MAX) runLog = runLog.slice(-RUN_MAX);
    try { localStorage.setItem(RUN_KEY, JSON.stringify(runLog)); } catch (e) {} };
  // the last entry before this start tells how the previous run ended (a reload leaves "page unloading" last)
  const prevLast = runLog[runLog.length - 1];
  persist('driver started', { previous: prevLast ? `${prevLast.t} ${prevLast.ev}` : null, url: location.href, ua: navigator.userAgent.slice(0, 120) });
  addEventListener('pagehide', () => persist('page unloading (reload, navigation or tab discarded)'));
  addEventListener('beforeunload', () => persist('page about to unload'));
  document.addEventListener('visibilitychange', () => persist('visibility ' + document.visibilityState));
  addEventListener('error', e => persist('page error', { msg: String(e.message || e.error || '').slice(0, 200), src: (e.filename || '').split('/').pop() + ':' + e.lineno }));
  addEventListener('unhandledrejection', e => persist('unhandled promise rejection', { msg: String(e.reason?.message || e.reason || '').slice(0, 200) }));
  window.r82runlog = () => runLog;
  window.r82stop = () => { stopped = true; say('paused by you'); };
  // controls used by the overlay's buttons
  window.r82setMode = m => { MODE = m === 'wilt' ? 'wilt' : 'advice'; finishAfterGame = false; foundWilt = false; };
  window.r82state = () => ({ running: looping && !stopped, mode: MODE, foundWilt, games, picks, restarts, errors, coinsGained: coinStart == null ? null : coinLast - coinStart });
  window.r82resume = () => { if (looping) return; stopped = false;
    if (games >= gamesEnd) gamesEnd = games + MAX_GAMES;
    if (restarts >= restartsEnd) restartsEnd = restarts + MAX_RESTARTS;
    if (foundWilt) { MODE = 'advice'; finishAfterGame = true; foundWilt = false; say('resuming: finishing this draft on the overlay\'s advice, then stopping'); }
    runLoop(); };
  window.r82log = log;

  // ---------- status box (drag to move; − / + to shrink to games and coins; position and size remembered) ----------
  const box = document.createElement('div');
  box.id = 'r82drvbox';
  let boxPos = null, mini = false;
  try { boxPos = JSON.parse(localStorage.getItem('r82drvpos')); mini = localStorage.getItem('r82drvmini') === '1'; } catch (e) {}
  const placeBox = () => { const x = boxPos ? Math.max(0, Math.min(boxPos.x, innerWidth - 40)) : 6, y = boxPos ? Math.max(0, Math.min(boxPos.y, innerHeight - 24)) : 6;
    box.style.left = x + 'px'; box.style.top = y + 'px'; };
  box.style.cssText = 'position:fixed;z-index:100000;background:#111827;color:#fff;font:12px/1.35 system-ui,sans-serif;padding:6px 8px;border-radius:6px;max-width:300px;opacity:.92;touch-action:none;user-select:none;cursor:move';
  placeBox(); document.body.append(box);
  const BTN = 'margin:4px 4px 0 0;padding:2px 8px;border-radius:4px;border:0;font:700 11px system-ui,sans-serif;cursor:pointer';
  // coins: the game labels its coin counter "Coin balance N"; the run's gain is the change since the driver started
  const coinNow = () => { for (const el of document.querySelectorAll('[aria-label]')) { const m = /coin balance\s*([\d,]+)/i.exec(el.getAttribute('aria-label') || ''); if (m) return +m[1].replace(/,/g, ''); } return null; };
  let coinStart = null, coinLast = null;
  const coinGain = () => { const c = coinNow(); if (c != null) { coinLast = c; if (coinStart == null) coinStart = c; } return coinStart == null ? null : coinLast - coinStart; };
  const coinText = () => { const g = coinGain(); return g == null ? 'coins ?' : `coins +${g} (now ${coinLast})`; };
  let lastTone = null, lastMsg = '';
  const drawBox = () => {
    box.style.background = lastTone === 'gold' ? '#a16207' : lastTone === 'warn' ? '#9a3412' : lastTone ? '#991b1b' : '#111827';
    const g = coinGain();
    if (mini) { box.style.padding = '3px 6px';
      box.innerHTML = `<b>82-0</b> ${MODE === 'wilt' ? '&#127919;' : ''} G ${games} &middot; ${g == null ? '?' : '+' + g}c${errors ? ' &middot; err ' + errors : ''}${lastTone && lastTone !== 'warn' ? ' &middot; <b>' + (lastTone === 'gold' ? 'FOUND' : 'STOPPED') + '</b>' : ''} <button data-d="mini" title="Expand" style="${BTN};margin:0 0 0 4px;padding:0 6px">+</button>`;
      return; }
    box.style.padding = '6px 8px';
    box.innerHTML = `<button data-d="mini" title="Shrink" style="${BTN};float:right;margin:0 0 0 6px;padding:0 6px">&minus;</button><b>82-0 driver</b> ${MODE === 'wilt' ? '&middot; WILT HUNT' : ''} ${DRY_RUN ? '(DRY RUN)' : ''}<br>games ${games}/${gamesEnd} &middot; picks ${picks} &middot; restarts ${restarts}${errors ? ` &middot; <b>errors ${errors}</b>` : ''} &middot; ${coinText()}<br>${lastMsg}<br>`
      + (looping && !stopped ? `<button data-d="pause" style="${BTN}">Pause</button>` : `<button data-d="resume" style="${BTN}">Resume</button>`); };
  const say = (msg, tone) => { lastTone = tone ?? null; lastMsg = msg; persist('status', { msg: String(msg).replace(/<[^>]+>/g, ' ').slice(0, 300), games, picks, restarts }); log.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
    drawBox(); console.log('[82-0 driver]', msg); try { window.r82render?.(); } catch (e) {} };
  // drag: press and move more than 6px; a press that doesn't move is a normal click
  let drag = null, dragged = false;
  box.addEventListener('pointerdown', e => { if (e.target.closest && e.target.closest('[data-d]')) return;
    const r = box.getBoundingClientRect(); drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false }; box.setPointerCapture?.(e.pointerId); });
  box.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return; drag.moved = true; boxPos = { x: drag.ox + dx, y: drag.oy + dy }; placeBox(); });
  box.addEventListener('pointerup', () => { if (drag?.moved) { dragged = true; try { localStorage.setItem('r82drvpos', JSON.stringify(boxPos)); } catch (e) {} } drag = null; });
  box.addEventListener('click', e => { if (dragged) { dragged = false; return; }
    const d = e.target.closest && e.target.closest('[data-d]'); if (!d) return;
    if (d.dataset.d === 'mini') { mini = !mini; try { localStorage.setItem('r82drvmini', mini ? '1' : '0'); } catch (er) {} drawBox(); }
    else if (d.dataset.d === 'pause') window.r82stop(); else window.r82resume(); });
  let looping = false, foundWilt = false;
  // Failures: by default the driver logs the error and tries to recover (pick the highest-value player that fits,
  // or quit and start a new draft). Critical ones (safety prompts, blocked controls, overlay missing) always stop,
  // and so does a run of failed recoveries.
  const MAX_CONSEC_FAILS = 3, MAX_RECOVERIES = 25;
  let needRecover = null, inRecovery = false, consecFails = 0, recoveries = 0, errors = 0;
  const fail = async (msg, critical = false) => {
    persist('error', { msg, critical, inRecovery }); persist('stop snapshot', snapshot()); diag();
    if (inRecovery) return false;                                  // the recovery itself reports the outcome
    if (!critical && consecFails < MAX_CONSEC_FAILS && recoveries < MAX_RECOVERIES) {
      errors++; consecFails++; needRecover = msg;
      say('ERROR: ' + msg + ' (recovering)', 'warn'); return false; }
    stopped = true;
    say('STOPPED: ' + msg + (critical ? '' : ` (${consecFails} failed recoveries in a row)`) + '<br><small>Resume to retry; export log from the overlay to send me the details</small>', true);
    return false; };
  const snapshot = () => { try {
    return { reason: log[log.length - 1], state: window.r820?.state ? { type: window.r820.state.type, open: window.r820.state.open, club: window.r820.state.club, era: window.r820.state.era, picked: window.r820.state.picked } : null,
      labels: [...document.querySelectorAll('button,[role=button]')].filter(b => !ours(b) && visible(b) && b.getAttribute('aria-label')).map(b => b.getAttribute('aria-label')).slice(0, 60),
      buttons: [...document.querySelectorAll('button,[role=button],a')].filter(b => !ours(b) && visible(b)).map(b => txt(b).replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean).slice(0, 80),
      dialogs: [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(d => visible(d)).map(d => txt(d).replace(/\s+/g, ' ').slice(0, 200)),
      court: !!court(), searchBox: !!searchBox(), url: location.href };
  } catch (e) { return { snapshotError: e.message }; } };

  // ---------- page helpers ----------
  const ours = el => el.closest && (el.closest('#r820panel') || el.closest('#r82drvbox'));
  const visible = el => { const r = el.getBoundingClientRect?.(); return r && r.width > 0 && r.height > 0; };
  const leaves = () => [...document.body.querySelectorAll('*')].filter(el => !el.children.length && !ours(el) && visible(el));
  const txt = el => (el.innerText || el.textContent || '').trim();
  const byText = (re, from = leaves()) => from.filter(el => re.test(txt(el)));
  const click = async (el, what, opts = {}) => {
    if (!el) return false;
    el = (el.closest && el.closest('button,[role=button]')) || el;   // act on the whole button, not just its text
    // hard block: never press boosters, re-rolls, sharing, account or ad controls, whatever the logic above decided
    const label = ((el.getAttribute && el.getAttribute('aria-label')) || '') + ' ' + txt(el);
    // (the one exception: a deliberate free/owned re-roll on the final pick in Auto, which passes allowRespin)
    const blocked = opts.allowCoins ? /double pick|\btrade\b|\bprime\b|booster|share results|sign out|watch|\bx2\b|rewarded/i
                  : opts.allowRespin ? /double pick|\btrade\b|\bprime\b|booster|share results|sign out|watch|\bx2\b|rewarded|coin balance/i
                                     : /double pick|\btrade\b|\bprime\b|respin|booster|share results|sign out|watch|\bx2\b|rewarded|coin balance/i;
    if (blocked.test(label)) {
      await fail(`refused to click a blocked control: "${label.trim().slice(0, 60)}"`, true); return false; }
    if (DRY_RUN) {   // a magenta frame drawn over the page (not on the element, so nothing can clip it); stays until the next action
      const r = el.getBoundingClientRect();
      marker.style.cssText = `position:fixed;z-index:100001;pointer-events:none;border:4px solid magenta;border-radius:6px;box-shadow:0 0 0 3px rgba(255,0,255,.35);left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 4}px;height:${r.height + 4}px`;
      marker.title = what; say('would click: ' + what); await sleep(1200); return true; }
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, { ...o, pointerId: 1, isPrimary: true }) : new MouseEvent(t, o));
    await sleep(GAP_MS);
    return true;
  };
  const typeInto = async (input, value) => {   // works with React-controlled inputs
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(350);
  };
  // the court: the smallest part of the page holding exactly one label for each position
  const court = () => {
    const labs = leaves().filter(el => SLOTS.includes(txt(el)));
    for (const l of labs.filter(el => txt(el) === 'C'))
      for (let a = l.parentElement; a && a !== document.body; a = a.parentElement) {
        const inside = labs.filter(x => a.contains(x)); if (inside.length < 5) continue;
        const map = {}; for (const x of inside) (map[txt(x)] ||= []).push(x);
        if (SLOTS.every(s => map[s]?.length === 1)) return map; break; }
    return null;
  };
  // A court position: empty ones are a button showing the position; filled ones are a jersey button showing the
  // player's initials, with the position label beside it. Either way, click the button nearest that label.
  const slotEl = s => {
    const lab = court()?.[s]?.[0];
    // fallback: with most positions filled the court may not show every label, but an open position is still a
    // button whose label is the position itself (the filter tabs G/F/C have no such label)
    if (!lab) return [...document.querySelectorAll('button,[role=button]')].find(b => !ours(b) && visible(b) && (b.getAttribute('aria-label') || '').trim() === s) || null;
    const own = lab.closest('button,[role=button]'); if (own && !ours(own)) return own;
    const r = lab.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // never pick a control that happens to sit near the label (the re-roll and booster buttons are close to the court)
    const notControl = b => !/respin|double pick|\btrade\b|\bprime\b|booster|spin|coin|menu|go back|player list|search|sort/i.test((b.getAttribute('aria-label') || '') + ' ' + txt(b));
    const near = [...document.querySelectorAll('button,[role=button]')].filter(b => !ours(b) && visible(b) && notControl(b))
      .map(b => { const q = b.getBoundingClientRect(); return [Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy), b]; })
      .sort((a, b) => a[0] - b[0])[0];
    return near && near[0] < 120 ? near[1] : lab; };
  const searchBox = () => [...document.querySelectorAll('input')].find(i => !ours(i) && visible(i) && /search/i.test(i.placeholder || i.getAttribute('aria-label') || ''));
  const button = re => byText(re).sort((a, b) => txt(a).length - txt(b).length)[0] || null;
  // A player's name element can contain an icon (a badge or star) as well as the text, so it isn't always a "leaf".
  // Match any element whose whole text is the name, keeping the innermost one.
  const norm = t => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  const byName = name => { const want = norm(name);
    const hits = [...document.body.querySelectorAll('*')].filter(el => !ours(el) && visible(el) && norm(txt(el)) === want);
    return hits.filter(el => !hits.some(o => o !== el && el.contains(o))); };
  const byLabel = re => [...document.querySelectorAll('button,[role=button],a')].find(b => !ours(b) && visible(b) && re.test(b.getAttribute('aria-label') || '')) || null;
  // the court view hides the player list; this button brings it back (and with it the search box)
  const showList = async () => { const b = byLabel(/show the player list/i); if (b) { await click(b, 'show player list'); await sleep(500); return true; } return false; };
  // Moves happen on the court, which the open player list covers. The game shows a "Hide the player list" button
  // whenever the list is open (and "Show the player list" when it's closed), so go by those buttons.
  const showCourt = async () => {
    const hide = byLabel(/hide the player list/i);
    if (!hide) return true;                     // list already closed
    await click(hide, 'hide player list'); await sleep(600);
    if (DRY_RUN) { await waitFor(() => !byLabel(/hide the player list/i) || null, 'the list to close'); }
    return true; };
  // anything we must never interact with or that needs a human
  const RED_FLAGS = /captcha|verify you are human|are you a robot|purchase|buy now|watch (an )?ad|subscribe|sign in to|log in to|something went wrong|too many requests/i;
  const checkRedFlags = () => { const dlg = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(d => !ours(d) && visible(d)).map(txt).join(' ');
    return RED_FLAGS.test(dlg) ? dlg.slice(0, 160) : null; };

  const diag = () => { const btns = [...document.querySelectorAll('button,[role=button],a')].filter(b => !ours(b) && visible(b)).map(b => (txt(b) || b.getAttribute('aria-label') || b.className || '?').slice(0, 30));
    const labels = [...document.querySelectorAll('button,[role=button]')].filter(b => !ours(b) && visible(b) && b.getAttribute('aria-label')).map(b => b.getAttribute('aria-label'));
    console.log('[82-0 driver] button labels:', labels);
    console.log('[82-0 driver] visible buttons:', btns, '| overlay next:', window.r820?.next, '| state:', window.r820?.state, '| court found:', !!court(), '| search box:', !!searchBox()); };

  // wait for the overlay to publish new advice (proves the last action registered)
  const waitSeq = async (from, ms = SEQ_WAIT) => { let t = Date.now(); while (Date.now() - t < ms) { if (stopped) return false;
    if (window.r820?.seq !== from) { await sleep(150); return true; }
    if (await whileHidden()) t = Date.now();   // restart the clock after a pause
    await sleep(120); } return false; };

  // ---------- actions ----------
  async function pickPlayer(name, slot) {
    const re = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    let cand = [];
    for (let attempt = 0; attempt < 5 && !cand.length && !stopped; attempt++) {
      if (await whileHidden()) attempt = 0;
      if (byLabel(/show the player list/i)) {   // list closed (e.g. after a move): open it
        await showList();
        if (DRY_RUN) await waitFor(() => !byLabel(/show the player list/i) || null, 'the list to open');
      }
      const sb = searchBox();
      if (sb) await typeInto(sb, name);
      cand = byName(name);
      if (!cand.length) await sleep(900);   // the list may still be filtering / animating
    }
    if (!cand.length) return fail(`player "${name}" not found in the list`);
    await click(cand[0], name);
    await sleep(COURT_MS - GAP_MS);
    const s = slotEl(slot); if (!s) return fail(`court position ${slot} not found after selecting ${name}`);
    await click(s, `${slot} for ${name}`);
    const sb = searchBox(); if (sb && sb.value) await typeInto(sb, '');
    return true;
  }
  async function movePlayer(name, to) {
    const from = window.r820?.state?.picked?.find(p => p.name === name)?.slot;
    if (!from) return fail(`can't tell where ${name} is to move him`);
    if (!(await showCourt())) return fail(`the player list is covering the court and no button to close it was found (move ${name} ${from} → ${to})`);
    // A filled position shows the player's initials on his jersey and may have no position label, so if the
    // position can't be found by its label, find the jersey by his initials (only if exactly one jersey matches).
    const initials = n => n.split(/\s+/).filter(w => /^[A-Za-z]/.test(w) && !/^(jr|sr|ii|iii|iv)\.?$/i.test(w)).map(w => w[0].toUpperCase());
    const ini = initials(name), want = ini.length > 1 ? ini[0] + ini[ini.length - 1] : ini.join('');
    const jersey = () => { const m = [...document.querySelectorAll('button,[role=button]')].filter(x => !ours(x) && visible(x) && txt(x).replace(/\s+/g, '') === want); return m.length === 1 ? m[0] : null; };
    const a = slotEl(from) || jersey(), b = slotEl(to);
    if (!a || !b) return fail(`court positions ${from}/${to} not found for the move (looked for ${name}'s jersey "${want}" too)`);
    await click(a, `${name}'s jersey at ${from}`); await sleep(700);
    const b2 = slotEl(to) || b; await click(b2, `${to} for ${name}`); await sleep(500);
    return true;
  }
  async function restart() {
    const back = byLabel(/^go back$/i);   // only the game's own "Go back" button; never guessed
    if (!back) return fail('back button not found for RESTART');
    await click(back, 'back');
    // the quit dialog animates in: let it settle before pressing, and press again if it's still there
    const findQuit = () => button(/^yes,?\s*quit\b/i);
    let quit = await waitFor(findQuit, '"Yes, Quit"'); if (!quit) return fail('"Yes, Quit" not found');
    for (let i = 0; i < 3 && quit && !stopped; i++) {
      if (await whileHidden()) { i = -1; quit = findQuit(); continue; }   // presses made while hidden don't register: retry once visible
      await sleep(600); await click(quit, 'Yes, Quit'); await sleep(900);
      if (await whileHidden()) i = -1;
      if (DRY_RUN) break;
      quit = findQuit();
    }
    if (quit && !DRY_RUN) return fail('"Yes, Quit" was pressed 3 times but the dialog is still open');
    return startClassic();
  }
  async function startClassic() {
    // New start screen (Oct 2026): a world carousel with one PLAY button, a PRO BASKETBALL / COLLEGE switch and a
    // CLASSIC / 1 VS 1 / HOOP IQ mode switch, each marking its choice with aria-selected / aria-pressed.
    // Make sure PRO BASKETBALL and CLASSIC are the selected ones, then press PLAY. Never touch MODE or the arrows.
    const sel = b => (b.getAttribute('aria-selected') || b.getAttribute('aria-pressed') || '') === 'true';
    const btnText = re => [...document.querySelectorAll('button,[role=button]')].filter(b => !ours(b) && visible(b) && re.test(txt(b).replace(/\s+/g, ' ').trim()));
    const newScreen = () => btnText(/^pro basketball$/i)[0] || null;
    if (await waitFor(() => newScreen() || btnText(/^play$/i)[0] || null, 'the start screen')) {
      if (newScreen()) {
        const ensure = async (re, what) => {
          const b = btnText(re)[0]; if (!b) return fail(`start screen: "${what}" option not found`, true);
          if (sel(b)) return true;
          await click(b, what); await sleep(700);
          return sel(btnText(re)[0] || b) || DRY_RUN || fail(`start screen: couldn't select "${what}"`, true); };
        if (!(await ensure(/^pro basketball$/i, 'PRO BASKETBALL'))) return false;
        if (btnText(/^classic$/i).length && !(await ensure(/^classic$/i, 'CLASSIC'))) return false;
        const plays = btnText(/^play$/i);
        if (plays.length !== 1) return fail(`start screen: expected one PLAY button, found ${plays.length}`, true);
        await click(plays[0], 'PLAY (Classic, Pro Basketball)'); await sleep(1500);
        return true;
      }
    }
    // Older start screen: one card per mode, each with its own PLAY.
    // On the home screen the Classic card has its own button. Its wording isn't certain, so accept a button
    // reading PLAY near the word CLASSIC, or one reading "Play Classic" / "Classic".
    // The start screen has several PLAY buttons (each mode card, Trivia, and the PLAY tab in the bottom bar).
    // Take the one inside the same card as the CLASSIC heading: climb from the heading until a container holds
    // exactly one PLAY button.
    const findPlay = () => {
      const heading = byText(/^classic$/i)[0]; if (!heading) return null;
      const plays = byText(/^play$/i);
      for (let a = heading.parentElement; a && a !== document.body; a = a.parentElement) {
        const inside = plays.filter(p => a.contains(p));
        if (inside.length === 1) return inside[0];
        if (inside.length > 1) break;
      }
      return null; };
    let play = await waitFor(findPlay, 'Classic "PLAY"');
    if (!play) {
      // fall back to the game's own page router, which opens the Classic draft without reloading (keeps the overlay)
      const router = window.next?.router;
      if (router?.push) { say('opening Classic via the page router'); if (!DRY_RUN) await router.push('/draft?mode=classic'); await sleep(1500); return true; }
      return fail('Classic "PLAY" not found on the start screen');
    }
    await click(play, 'Classic PLAY'); await sleep(1500);
    return true;
  }
  const waitFor = async (find, what) => { const t = Date.now(), ms = DRY_RUN ? 45000 : 5000;
    if (DRY_RUN) say(`dry run: do the outlined step yourself; waiting for ${what}`);
    let t0 = t; while (Date.now() - t0 < ms && !stopped) { const el = find(); if (el) return el; if (await whileHidden()) t0 = Date.now(); await sleep(250); } return null; };
  const dist = (a, b) => { const r = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return Math.hypot(r.left - q.left, r.top - q.top); };
  const findClaim = () => byText(/^claim\b/i).filter(el => !/x2|double|watch|\bad\b|video/i.test(txt(el.closest('button,[role=button]') || el))).sort((a, b) => txt(a).length - txt(b).length)[0] || null;
  async function finishGame() {
    // the coins reward pops up a moment after the result: give it time before reaching for DRAFT AGAIN
    for (let t = 0; t < 12 && !findClaim() && !stopped; t++) await sleep(250);
    for (let i = 0; i < 6 && !stopped; i++) {      // reward / level-up screens come in some order
      const claim = byText(/^claim\b/i).filter(el => !/x2|double|watch|\bad\b|video/i.test(txt(el.closest('button,[role=button]') || el))).sort((a, b) => txt(a).length - txt(b).length)[0] || null, tap = byText(/tap anywhere/i)[0], again = button(/^draft again\b/i);
      if (claim) { await click(claim, 'CLAIM'); continue; }
      if (tap) { await click(tap, 'level-up'); continue; }
      if (again) { await click(again, 'DRAFT AGAIN'); await sleep(1500); return true; }
      await sleep(800);
    }
    return fail('"DRAFT AGAIN" not found after the result');
  }
  // SPIN sends the pick you just placed and spins the next club/era. After the fifth pick the same job is done by a
  // finishing button; its exact wording isn't known yet, so a few likely labels are tried and anything else stops.
  async function spin(last) {
    const b = button(/^spin$/i) || (last ? button(/^(simulate|sim season|play season|finish|see results|submit|done|confirm)$/i) : null);
    if (!b) return false;
    await click(b, txt(b).toUpperCase()); return true;
  }

  // ---------- main loop (can be paused and resumed) ----------
  let lastResultSeen = null, idle = 0;
  async function innerLoop() {
  while (!stopped && !needRecover && games < gamesEnd && restarts < restartsEnd) {
    const flag = checkRedFlags(); if (flag) { await fail('unexpected prompt: ' + flag, true); break; }
    await whileHidden();
    const stray = findClaim() || byText(/tap anywhere/i)[0];
    if (stray) { await click(stray, txt(stray).toUpperCase() || 'popup'); if (DRY_RUN) await sleep(2000); continue; }
    const seq = window.r820.seq, next = window.r820.next || 'WAIT', parts = next.split('|');
    const kind = parts[0];
    if (kind === 'WAIT') { if (!(await spin())) { if (++idle > 25) { await fail('nothing to do: no spin button and no advice'); break; } await sleep(400); } else await waitSeq(seq); continue; }
    idle = 0;
    if (kind === 'NONE') { await fail('overlay says nobody on this spin fits'); break; }
    if (kind === 'RESULT') {
      const key = parts.slice(1).join('|') + '|' + window.r820.seq;
      if (lastResultSeen !== key) { lastResultSeen = key; games++; sPicks = 0; say(`game ${games}: ${parts[1]} (score ${parts[2]}, model ${window.r820.state?.model})`);
        if (finishAfterGame) { stopped = true; say(`done: the #1 C draft finished ${parts[1]} (score ${parts[2]})`, 'gold'); break; } }
      await finishGame(); await waitSeq(seq, 4000); continue;
    }
    if (MODE === 'wilt') {
      const st = window.r820.state || {}, offer = st.offer || [], open = st.open || [];
      const wilt = offer.filter(p => p.ranks && p.ranks.C <= HUNT_TOP_C).sort((a, b) => a.ranks.C - b.ranks.C)[0];
      if (wilt) { foundWilt = true; stopped = true;
        say(`FOUND the #${wilt.ranks.C} C: ${wilt.name} ${st.club} ${st.era} (value ${wilt.value}). Your turn. Press Resume to let it finish this draft on the overlay's advice.`, 'gold');
        try { const ac = new AudioContext(), o = ac.createOscillator(); o.frequency.value = 880; o.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.4); } catch (e) {}   // a short beep
        break; }
      if (sPicks >= KEEP_AFTER_S) { /* committed: play the rest of this draft on the overlay's advice below */ }
      else {
      const nonC = open.filter(x => x !== 'C');
      const cands = offer.flatMap(p => Object.entries(p.ranks || {}).filter(([x, r]) => nonC.includes(x) && r <= 10).map(([x, r]) => ({ name: p.name, slot: x, r, v: p.value })))
        .sort((a, b) => b.v - a.v || a.r - b.r);
      if (!cands.length) { restarts++; sPicks = 0; say(`no S-grade player for ${nonC.join('/') || 'any open position'} on ${st.club} ${st.era}: new draft`); if (!(await restart())) break; await waitSeq(seq, 6000); continue; }
      const c = cands[0];
      say(`S-grade: take ${c.name} → ${c.slot} (#${c.r} ${c.slot})`);
      if (!(await pickPlayer(c.name, c.slot))) break;
      if (!(await spin(false))) { await fail('placed the player but found no SPIN button to send the pick'); break; }
      if (!(await waitSeq(seq))) { await fail(`pick of ${c.name} → ${c.slot} did not register`); break; }
      picks++; sPicks++; consecFails = 0;
      if (sPicks >= KEEP_AFTER_S) say(`${sPicks} S-grade picks: keeping this draft and finishing it on the overlay's advice`);
      continue;
      }
    }
    if (kind === 'RESTART' && MODE === 'advice' && !AUTO_QUITS) {
      const o = window.r820?.state?.otherwise;
      if (!o) { await fail('overlay advised a restart without a pick to fall back on (overlay v36+ needed)'); break; }
      say(`weak first spin: playing it out anyway, take ${o.name} → ${o.slot}`);
      if (!(await pickPlayer(o.name, o.slot))) break;
      if (!(await spin(false))) { await fail('placed the player but found no SPIN button to send the pick'); break; }
      if (!(await waitSeq(seq))) { await fail(`pick of ${o.name} → ${o.slot} did not register`); break; }
      picks++; consecFails = 0; continue;
    }
    if (kind === 'RESTART') { restarts++; sPicks = 0; say('restart (weak first spin)'); if (!(await restart())) break; await waitSeq(seq, 6000); continue; }
    // TAKE, MOVE...|TAKE, or REROLL_* (never re-roll: take the "otherwise" pick)
    // Auto mode, final pick: if the overlay recommends a re-roll and it's free, owned or bought with coins, use it.
    // Re-rolls that need an ad are never used; any other re-roll advice takes the "otherwise" pick.
    if (kind.startsWith('REROLL') && MODE === 'advice' && (window.r820?.state?.picked?.length || 0) === 4) {
      const cost = String(window.r820?.state?.cost || ''), scope = kind === 'REROLL_ERA' ? 'era' : 'team';
      if (cost === 'free' || /owned/i.test(cost) || /coins/i.test(cost)) {
        const btn = byLabel(new RegExp('^respin ' + scope, 'i'));
        if (btn && !/\(0 left\)/i.test(btn.getAttribute('aria-label') || '')) {
          say(`final pick: using the ${scope} re-roll (${cost})`);
          await click(btn, `re-roll ${scope}`, { allowRespin: true });
          // a coin re-roll asks "spend 100 coins?" first: press its confirm button (never a cancel, close or ad option)
          if (/coins/i.test(cost)) {
            const confirmBtn = await waitFor(() => {
              const scopeEls = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(d => !ours(d) && visible(d));
              const pool = (scopeEls.length ? scopeEls.flatMap(d => [...d.querySelectorAll('button,[role=button]')]) : [...document.querySelectorAll('button,[role=button]')])
                .filter(b => !ours(b) && visible(b));
              const ok = pool.filter(b => { const t = (txt(b) + ' ' + (b.getAttribute('aria-label') || '')).trim();
                return /confirm|yes|spend|\buse\b|re-?roll|respin|continue|\bok\b|\b100\b/i.test(t) && !/cancel|\bno\b|close|not now|watch|\bad\b|video|free/i.test(t); });
              return scopeEls.length ? ok[0] || null : ok.find(b => /spend|confirm|\b100\b/i.test(txt(b))) || null; }, 'the "spend coins" confirmation');
            if (!confirmBtn) { await fail(`clicked the ${scope} re-roll but couldn't find the "spend coins" confirm button`); break; }
            await click(confirmBtn, `confirm coin re-roll: "${txt(confirmBtn).replace(/\s+/g, ' ').slice(0, 30)}"`, { allowRespin: true, allowCoins: true });
          }
          if (!(await waitSeq(seq))) { await fail(`the ${scope} re-roll did not register`); break; }
          rerollsUsed++; continue;
        }
        say(`final pick: ${scope} re-roll recommended but its button shows none left; taking the other pick`);
      } else say(`final pick: ${scope} re-roll recommended but it ${cost || 'has a cost'}; taking the other pick`);
    }
    // re-roll advice not acted on above, and all booster advice (never used by the driver): take the "otherwise" pick
    const alt = kind.startsWith('REROLL') || kind.startsWith('BOOST');
    if (alt) skippedRerolls++;
    let i = alt ? 1 : 0, ok = true;
    const take = alt ? ['TAKE', parts[1], parts[2]] : null;
    while (ok && !take && parts[i] === 'MOVE') { /* MOVE|a>PF|b>SF|TAKE|... */ i++;
      while (i < parts.length && parts[i] !== 'TAKE') { const [n, to] = parts[i].split('>'); ok = await movePlayer(n, to); i++; } }
    if (!ok) break;
    const [, name, slot] = take || parts.slice(i);
    say(`${kind.startsWith('REROLL') ? 'skip re-roll, ' : kind.startsWith('BOOST') ? 'booster advised (left for you), ' : ''}take ${name} → ${slot}`);
    if (!(await pickPlayer(name, slot))) break;
    // placing is local; the pick is only sent when SPIN (or, after the fifth pick, the finishing button) is pressed
    // ...except the fifth pick: the game sends it and shows the result by itself, with no button to press
    const last = (window.r820?.state?.picked?.length || 0) >= 4;
    if (!last && !(await spin(false))) { await fail('placed the player but found no SPIN button to send the pick'); break; }
    if (!(await waitSeq(seq))) {   // one retry: the court may not have been ready, so place again and re-send
      const s = slotEl(slot); if (s) { say(`retrying ${slot} for ${name}`); await click(s, slot); if (!last) await spin(false); }
      if (!(await waitSeq(seq))) { await fail(`pick of ${name} → ${slot} did not register`); break; }
    }
    picks++; consecFails = 0;
  }
  }
  // ---------- recovery: fall back to the highest-value player that fits; failing that, quit and start again ----------
  async function recover(why) {
    inRecovery = true; recoveries++;
    try {
      await sleep(1500); await whileHidden();
      const st = window.r820?.state || {}, kind = (window.r820?.next || '').split('|')[0];
      if (kind === 'RESULT' || kind === 'WAIT') { say('recovered: back on track (' + kind.toLowerCase() + ')'); return true; }
      const open = st.open || [], offer = (st.offer || []).slice().sort((a, b) => b.value - a.value);
      const seq = window.r820?.seq;
      for (const p of offer.slice(0, 4)) {
        const slots = (p.positions || []).filter(x => open.includes(x)).sort((a, b) => ((p.ranks || {})[a] ?? 999) - ((p.ranks || {})[b] ?? 999));
        if (!slots.length) continue;
        say(`recovering from "${why}": taking ${p.name} → ${slots[0]} (highest value that fits)`, 'warn');
        if (!(await pickPlayer(p.name, slots[0]))) continue;
        const last = (st.picked?.length || 0) >= 4;
        if (!last) await spin(false);
        if (await waitSeq(seq)) { picks++; persist('recovered', { how: 'fallback pick', player: p.name, slot: slots[0] }); say(`recovered: took ${p.name} → ${slots[0]}`); return true; }
      }
      say(`recovering from "${why}": no fallback pick worked, quitting to start a new draft`, 'warn');
      if (await restart()) { restarts++; sPicks = 0; await waitSeq(seq, 6000); persist('recovered', { how: 'restart' }); say('recovered: started a new draft'); return true; }
      return false;
    } finally { inRecovery = false; }
  }
  async function runLoop() {
    looping = true; say(MODE === 'wilt' ? 'hunting for Wilt (#1 or #2 C)' : 'running');
    while (true) {
      needRecover = null;
      await innerLoop();
      if (stopped || !needRecover) break;
      const why = needRecover;
      if (!(await recover(why))) { consecFails = MAX_CONSEC_FAILS; await fail('could not recover from: ' + why); break; }
    }
  if (!stopped) say(`batch done (${games >= gamesEnd ? MAX_GAMES + ' games' : MAX_RESTARTS + ' restarts'}): ${games} games, ${picks} picks, ${restarts} restarts so far. Press Resume for another batch.`);
  looping = false; say(log[log.length - 1].slice(9), lastTone);   // redraw with a Resume button, same colour
  }
  if (!window.r820 || !/^v(\d+)/.test(window.r820.version || '') || +window.r820.version.slice(1) < 36) return fail('overlay v36+ not loaded (reload the page and run r820)', true);
  runLoop();
})();
