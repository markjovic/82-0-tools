// 82-0 auto-driver: plays Classic drafts by following the overlay's instruction (window.r820.next), clicking the
// page itself. No AI round-trips, so a pick takes a few seconds instead of 10-15.
// Needs overlay v30+. Never re-rolls, never uses any booster, never spends coins, never watches ads.
// Stop at any time with:  r82stop()      Status: the small box at the top-left of the page.
(async () => {
  if (window.r82drv) { console.log('driver already running'); return; }
  window.r82drv = true;

  // ---------- settings ----------
  const MAX_GAMES  = 30;     // stop after this many finished games
  const GAP_MS     = 700;    // pause between actions (human pace; don't go much lower)
  const COURT_MS   = 1700;   // the court slides in after a player is selected; clicks before this are ignored
  const SEQ_WAIT   = 9000;   // how long to wait for the overlay to confirm an action registered
  const DRY_RUN    = !!window.r82dry;  // set window.r82dry = true before loading to outline targets without clicking

  const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let stopped = false, games = 0, picks = 0, restarts = 0, skippedRerolls = 0;
  const log = [];
  window.r82stop = () => { stopped = true; say('stopped by you'); };
  window.r82log = log;

  // ---------- status box ----------
  const box = document.createElement('div');
  box.id = 'r82drvbox';
  box.style.cssText = 'position:fixed;left:6px;top:6px;z-index:100000;background:#111827;color:#fff;font:12px/1.35 system-ui,sans-serif;padding:6px 8px;border-radius:6px;max-width:300px;opacity:.9';
  document.body.append(box);
  const say = (msg, bad) => { log.push(new Date().toISOString().slice(11, 19) + ' ' + msg); box.style.background = bad ? '#991b1b' : '#111827';
    box.innerHTML = `<b>82-0 driver</b> ${DRY_RUN ? '(DRY RUN)' : ''}<br>games ${games}/${MAX_GAMES} &middot; picks ${picks} &middot; restarts ${restarts}<br>${msg}<br><small>r82stop() to stop</small>`; console.log('[82-0 driver]', msg); };
  const fail = async msg => { stopped = true; say('STOPPED: ' + msg + '<br><small>see r82log and the console</small>', true); diag(); };

  // ---------- page helpers ----------
  const ours = el => el.closest && (el.closest('#r820panel') || el.closest('#r82drvbox'));
  const visible = el => { const r = el.getBoundingClientRect?.(); return r && r.width > 0 && r.height > 0; };
  const leaves = () => [...document.body.querySelectorAll('*')].filter(el => !el.children.length && !ours(el) && visible(el));
  const txt = el => (el.innerText || el.textContent || '').trim();
  const byText = (re, from = leaves()) => from.filter(el => re.test(txt(el)));
  const click = async (el, what) => {
    if (!el) return false;
    if (DRY_RUN) { el.style.outline = '3px solid magenta'; say('would click: ' + what); await sleep(1200); el.style.outline = ''; return true; }
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
  const slotEl = s => court()?.[s]?.[0] || null;
  const searchBox = () => [...document.querySelectorAll('input')].find(i => !ours(i) && visible(i) && /search/i.test(i.placeholder || i.getAttribute('aria-label') || ''));
  const button = re => byText(re).sort((a, b) => txt(a).length - txt(b).length)[0] || null;
  const byLabel = re => [...document.querySelectorAll('button,[role=button],a')].find(b => !ours(b) && visible(b) && re.test(b.getAttribute('aria-label') || '')) || null;
  // the court view hides the player list; this button brings it back (and with it the search box)
  const showList = async () => { const b = byLabel(/show the player list/i); if (b) { await click(b, 'show player list'); await sleep(500); return true; } return false; };

  // anything we must never interact with or that needs a human
  const RED_FLAGS = /captcha|verify you are human|are you a robot|purchase|buy now|watch (an )?ad|subscribe|sign in to|log in to|something went wrong|too many requests/i;
  const checkRedFlags = () => { const dlg = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(d => !ours(d) && visible(d)).map(txt).join(' ');
    return RED_FLAGS.test(dlg) ? dlg.slice(0, 160) : null; };

  const diag = () => { const btns = [...document.querySelectorAll('button,[role=button],a')].filter(b => !ours(b) && visible(b)).map(b => (txt(b) || b.getAttribute('aria-label') || b.className || '?').slice(0, 30));
    console.log('[82-0 driver] visible buttons:', btns, '| overlay next:', window.r820?.next, '| state:', window.r820?.state, '| court found:', !!court(), '| search box:', !!searchBox()); };

  // wait for the overlay to publish new advice (proves the last action registered)
  const waitSeq = async (from, ms = SEQ_WAIT) => { const t = Date.now(); while (Date.now() - t < ms) { if (stopped) return false; if (window.r820?.seq !== from) { await sleep(150); return true; } await sleep(120); } return false; };

  // ---------- actions ----------
  async function pickPlayer(name, slot) {
    const re = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    let cand = [];
    for (let attempt = 0; attempt < 3 && !cand.length && !stopped; attempt++) {
      if (!searchBox()) await showList();
      const sb = searchBox();
      if (sb) await typeInto(sb, name);
      cand = byText(re);
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
    const a = slotEl(from), b = slotEl(to); if (!a || !b) return fail(`court positions ${from}/${to} not found for the move`);
    await click(a, `${name} at ${from}`); await sleep(500); await click(b, `${to} for ${name}`);
    return true;
  }
  async function restart() {
    const back = byLabel(/^go back$/i) || [...document.querySelectorAll('button,[role=button],a')].find(b => !ours(b) && visible(b) && (/back/i.test(b.getAttribute('aria-label') || '') || /^[‹<←]$/.test(txt(b))))
      || [...document.querySelectorAll('button')].filter(b => !ours(b) && visible(b)).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    if (!back) return fail('back button not found for RESTART');
    await click(back, 'back');
    const quit = button(/^yes,?\s*quit\b/i); if (!quit) return fail('"Yes, Quit" not found');
    await click(quit, 'Yes, Quit'); await sleep(1200);
    return startClassic();
  }
  async function startClassic() {
    const classic = byText(/^classic$/i)[0];
    const plays = byText(/^play$/i);
    const play = classic ? plays.sort((a, b) => dist(a, classic) - dist(b, classic))[0] : plays[0];
    if (!play) return fail('Classic "PLAY" not found');
    await click(play, 'Classic PLAY'); await sleep(1500);
    return true;
  }
  const dist = (a, b) => { const r = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return Math.hypot(r.left - q.left, r.top - q.top); };
  async function finishGame() {
    for (let i = 0; i < 6 && !stopped; i++) {      // reward / level-up screens come in some order
      const claim = button(/^claim\b/i), tap = byText(/tap anywhere/i)[0], again = button(/^draft again\b/i);
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

  // ---------- main loop ----------
  if (!window.r820 || !/^v(\d+)/.test(window.r820.version || '') || +window.r820.version.slice(1) < 30) return fail('overlay v30+ not loaded (run r820 first)');
  say('running');
  let lastResultSeen = null, idle = 0;
  while (!stopped && games < MAX_GAMES) {
    const flag = checkRedFlags(); if (flag) { await fail('unexpected prompt: ' + flag); break; }
    const seq = window.r820.seq, next = window.r820.next || 'WAIT', parts = next.split('|');
    const kind = parts[0];
    if (kind === 'WAIT') { if (!(await spin())) { if (++idle > 25) { await fail('nothing to do: no spin button and no advice'); break; } await sleep(400); } else await waitSeq(seq); continue; }
    idle = 0;
    if (kind === 'NONE') { await fail('overlay says nobody on this spin fits'); break; }
    if (kind === 'RESULT') {
      const key = parts.slice(1).join('|') + '|' + window.r820.seq;
      if (lastResultSeen !== key) { lastResultSeen = key; games++; say(`game ${games}: ${parts[1]} (score ${parts[2]}, model ${window.r820.state?.model})`); }
      await finishGame(); await waitSeq(seq, 4000); continue;
    }
    if (kind === 'RESTART') { restarts++; say('restart (weak first spin)'); if (!(await restart())) break; await waitSeq(seq, 6000); continue; }
    // TAKE, MOVE...|TAKE, or REROLL_* (never re-roll: take the "otherwise" pick)
    if (kind.startsWith('REROLL')) skippedRerolls++;
    let i = kind.startsWith('REROLL') ? 1 : 0, ok = true;
    const take = kind.startsWith('REROLL') ? ['TAKE', parts[1], parts[2]] : null;
    while (ok && !take && parts[i] === 'MOVE') { /* MOVE|a>PF|b>SF|TAKE|... */ i++;
      while (i < parts.length && parts[i] !== 'TAKE') { const [n, to] = parts[i].split('>'); ok = await movePlayer(n, to); i++; } }
    if (!ok) break;
    const [, name, slot] = take || parts.slice(i);
    say(`${kind.startsWith('REROLL') ? 'skip re-roll, ' : ''}take ${name} → ${slot}`);
    if (!(await pickPlayer(name, slot))) break;
    // placing is local; the pick is only sent when SPIN (or, after the fifth pick, the finishing button) is pressed
    const last = (window.r820?.state?.picked?.length || 0) >= 4;
    if (!(await spin(last))) { await fail(last ? 'placed the fifth player but found no button to finish the draft' : 'placed the player but found no SPIN button to send the pick'); break; }
    if (!(await waitSeq(seq))) {   // one retry: the court may not have been ready, so place again and re-send
      const s = slotEl(slot); if (s) { say(`retrying ${slot} for ${name}`); await click(s, slot); await spin(last); }
      if (!(await waitSeq(seq))) { await fail(`pick of ${name} → ${slot} did not register`); break; }
    }
    picks++;
  }
  if (!stopped) say(`done: ${games} games, ${picks} picks, ${restarts} restarts, ${skippedRerolls} re-rolls skipped`);
  window.r82drv = false;
})();
