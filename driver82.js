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
  const marker = document.createElement('div'); document.body.append(marker);
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
    el = (el.closest && el.closest('button,[role=button]')) || el;   // act on the whole button, not just its text
    // hard block: never press boosters, re-rolls, sharing, account or ad controls, whatever the logic above decided
    const label = ((el.getAttribute && el.getAttribute('aria-label')) || '') + ' ' + txt(el);
    if (/double pick|\btrade\b|\bprime\b|respin|booster|share results|sign out|watch|\bx2\b|rewarded|coin balance/i.test(label)) {
      await fail(`refused to click a blocked control: "${label.trim().slice(0, 60)}"`); return false; }
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
    const lab = court()?.[s]?.[0]; if (!lab) return null;
    const own = lab.closest('button,[role=button]'); if (own && !ours(own)) return own;
    const r = lab.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const near = [...document.querySelectorAll('button,[role=button]')].filter(b => !ours(b) && visible(b))
      .map(b => { const q = b.getBoundingClientRect(); return [Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy), b]; })
      .sort((a, b) => a[0] - b[0])[0];
    return near && near[0] < 120 ? near[1] : lab; };
  const searchBox = () => [...document.querySelectorAll('input')].find(i => !ours(i) && visible(i) && /search/i.test(i.placeholder || i.getAttribute('aria-label') || ''));
  const button = re => byText(re).sort((a, b) => txt(a).length - txt(b).length)[0] || null;
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
  const waitSeq = async (from, ms = SEQ_WAIT) => { const t = Date.now(); while (Date.now() - t < ms) { if (stopped) return false; if (window.r820?.seq !== from) { await sleep(150); return true; } await sleep(120); } return false; };

  // ---------- actions ----------
  async function pickPlayer(name, slot) {
    const re = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    let cand = [];
    for (let attempt = 0; attempt < 3 && !cand.length && !stopped; attempt++) {
      if (byLabel(/show the player list/i)) {   // list closed (e.g. after a move): open it
        await showList();
        if (DRY_RUN) await waitFor(() => !byLabel(/show the player list/i) || null, 'the list to open');
      }
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
    if (!(await showCourt())) return fail(`the player list is covering the court and no button to close it was found (move ${name} ${from} → ${to})`);
    const a = slotEl(from), b = slotEl(to); if (!a || !b) return fail(`court positions ${from}/${to} not found for the move`);
    await click(a, `${name}'s jersey at ${from}`); await sleep(700);
    const b2 = slotEl(to) || b; await click(b2, `${to} for ${name}`); await sleep(500);
    return true;
  }
  async function restart() {
    const back = byLabel(/^go back$/i) || [...document.querySelectorAll('button,[role=button],a')].find(b => !ours(b) && visible(b) && (/back/i.test(b.getAttribute('aria-label') || '') || /^[‹<←]$/.test(txt(b))))
      || [...document.querySelectorAll('button')].filter(b => !ours(b) && visible(b)).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    if (!back) return fail('back button not found for RESTART');
    await click(back, 'back');
    const quit = await waitFor(() => button(/^yes,?\s*quit\b/i), '"Yes, Quit"'); if (!quit) return fail('"Yes, Quit" not found');
    await click(quit, 'Yes, Quit'); await sleep(1200);
    return startClassic();
  }
  async function startClassic() {
    const findPlay = () => { const classic = byText(/^classic$/i)[0], plays = byText(/^play$/i);
      return classic ? plays.sort((a, b) => dist(a, classic) - dist(b, classic))[0] : plays[0]; };
    const play = await waitFor(findPlay, 'Classic "PLAY"');
    if (!play) return fail('Classic "PLAY" not found');
    await click(play, 'Classic PLAY'); await sleep(1500);
    return true;
  }
  const waitFor = async (find, what) => { const t = Date.now(), ms = DRY_RUN ? 45000 : 5000;
    if (DRY_RUN) say(`dry run: do the outlined step yourself; waiting for ${what}`);
    while (Date.now() - t < ms && !stopped) { const el = find(); if (el) return el; await sleep(250); } return null; };
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

  // ---------- main loop ----------
  if (!window.r820 || !/^v(\d+)/.test(window.r820.version || '') || +window.r820.version.slice(1) < 30) return fail('overlay v30+ not loaded (run r820 first)');
  say('running');
  let lastResultSeen = null, idle = 0;
  while (!stopped && games < MAX_GAMES) {
    const flag = checkRedFlags(); if (flag) { await fail('unexpected prompt: ' + flag); break; }
    const stray = findClaim() || byText(/tap anywhere/i)[0];
    if (stray) { await click(stray, txt(stray).toUpperCase() || 'popup'); if (DRY_RUN) await sleep(2000); continue; }
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
    // ...except the fifth pick: the game sends it and shows the result by itself, with no button to press
    const last = (window.r820?.state?.picked?.length || 0) >= 4;
    if (!last && !(await spin(false))) { await fail('placed the player but found no SPIN button to send the pick'); break; }
    if (!(await waitSeq(seq))) {   // one retry: the court may not have been ready, so place again and re-send
      const s = slotEl(slot); if (s) { say(`retrying ${slot} for ${name}`); await click(s, slot); if (!last) await spin(false); }
      if (!(await waitSeq(seq))) { await fail(`pick of ${name} → ${slot} did not register`); break; }
    }
    picks++;
  }
  if (!stopped) say(`done: ${games} games, ${picks} picks, ${restarts} restarts, ${skippedRerolls} re-rolls skipped`);
  window.r82drv = false;
})();
