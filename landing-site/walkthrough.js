/* Reclaim — the home page walkthrough ("See the money and the proof").
   One still of the open laptop (blender/macbook.py still=1 → /media/macbook/still.webp, still-m.webp on phones)
   with the live dashboard (.wt-screen) laid on its glass. The screen in the still is square to the camera, so the
   dashboard is placed with a plain translate + scale, once per layout, never per frame.

   The page scrolls freely. While the section is pinned (sticky), the scroll position picks a step: the intro, the
   five steps (each caption names the screen to show and what to frame), then the close. Changing step only swaps
   classes and sets one transform on the stage; CSS transitions run the move on the compositor, so nothing is
   drawn or measured while it plays. The step bar and Skip scroll the page to where they point.
   Registered as a page module: main.js runs it with its shared helpers. */
(window.reclaimModules = window.reclaimModules || []).push(({ $, $$, ScrollTrigger, lenis, rem, calm, docTop }) => {
  const sec = $('[data-walkthrough]');
  if (!sec) return;
  const pin = $('.wt-pin', sec), head = $('.wt-head', sec), outro = $('.wt-outro', sec);
  const stage = $('.wt-stage', sec), still = $('.wt-still', sec);
  const screen = $('.wt-screen', sec), spot = $('.wt-spot', sec), veil = $('path', spot);
  const nav = $('.the-nav');
  const shots = $$('.wt-shot', sec), caps = $$('.wt-cap', sec);
  const pill = $('.wt-pill', sec), pills = $$('button', pill), end = $('.wt-end', sec);
  const phone = matchMedia('(max-width: 1023px)').matches;   // picked once: the image does not swap on resize
  const stillUrl = '/media/macbook/' + (phone ? 'still-m' : 'still') + '.webp';

  // the still's shape, and where its screen sits in it (normalised; from corners.json "still")
  const ASPECT = 3379 / 3840;
  const GLASS = { l: .16438, t: .08174, r: .83562, b: .58805 };

  let W = 0, H = 0, ss = 1;   // stage size (px, at scale 1) and the dashboard's scale onto the glass
  const placeScreen = () => {
    W = stage.offsetWidth; H = W * ASPECT;
    ss = (GLASS.r - GLASS.l) * W / screen.offsetWidth;
    screen.style.transform = `translate(${GLASS.l * W}px, ${GLASS.t * H}px) scale(${ss})`;
    screen.classList.add('is-mapped');
  };

  const setSettled = on => shots.forEach(s => s.classList.toggle('is-settled', on));
  // the screens showing, bottom to top: a new one fades in over the last, which stays until it is covered, so the
  // glass is never bare however fast the steps go by. Back to one still underneath: whatever is over it fades off.
  let stack = [], z = 0;
  const showShot = name => {
    const s = shots.find(x => x.dataset.shot === name), i = stack.indexOf(s);
    if (i < 0) {
      stack.push(s);
      s.style.zIndex = ++z;
      s.classList.remove('is-out');
      s.classList.add('is-on');
    } else stack.splice(i + 1).forEach(x => { x.classList.remove('is-on'); x.classList.add('is-out'); });
  };
  shots.forEach(s => s.addEventListener('transitionend', e => {
    if (e.target !== s || e.propertyName !== 'opacity' || s !== stack.at(-1)) return;
    stack.splice(0, stack.length - 1).forEach(x => x.classList.remove('is-on'));   // covered now
  }));

  // the layout box of the data-f names inside a screen (their union), in the dashboard's own px
  const offset = el => { let x = 0, y = 0; for (let n = el; n && n !== screen; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; } return [x, y]; };
  const measure = cap => {
    const shot = shots.find(s => s.dataset.shot === cap.dataset.shot);
    const was = shot.classList.contains('is-settled');
    shot.classList.toggle('is-settled', cap.hasAttribute('data-settled'));   // the settled rows only lay out in that state
    const names = ((phone && cap.dataset.focusM) || cap.dataset.focus).split(' ');
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    names.forEach(n => {
      const el = $(`[data-f="${n}"]`, shot);
      if (!el) return;
      const [x, y] = offset(el);
      l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x + el.offsetWidth); b = Math.max(b, y + el.offsetHeight);
    });
    shot.classList.toggle('is-settled', was);
    const p = rem() * 1.2;
    return { x: l - p, y: t - p, w: r - l + p * 2, h: b - t + p * 2 };
  };

  if (calm) {
    // reduced motion: the open laptop, the case on its screen, the steps listed under it
    showShot('finding');
    still.src = stillUrl;
    placeScreen();
    addEventListener('resize', placeScreen);
    return;
  }

  // ---------- the steps ----------
  // Positions in screens of scroll from the section's top: the intro until START, then each step STEP long,
  // then the close; the pin lets go one STEP after the close begins.
  const START = .35, STEP = .9, CLOSE = 6;
  const LEN = START + CLOSE * STEP;
  const unit = () => pin.clientHeight || innerHeight;
  const pos = () => (scrollY - docTop(sec)) / unit();
  const stepAt = p => (p < START ? 0 : Math.min(CLOSE, 1 + Math.floor((p - START) / STEP)));
  const posY = k => docTop(sec) + (k ? START + (k - .5) * STEP : 0) * unit();   // the middle of step k
  const isStep = k => k >= 1 && k <= 5;

  // ---------- layout: a camera view (translate + scale of the stage) for the intro, each step and the close ----------
  let base = { x: 0, y: 0, s: 1 }, close = base, views = [], spots = [];
  const fit = (rx, ry, rw, rh, L, T, R, B, max) => {
    const s = Math.min((R - L) / rw, (B - T) / rh, max);
    return { x: (L + R) / 2 - (rx + rw / 2) * s, y: (T + B) / 2 - (ry + rh / 2) * s, s };
  };
  const layout = () => {
    const vw = pin.clientWidth, vh = pin.clientHeight, r = rem();
    stage.style.width = (phone ? vw * 1.3 : Math.min(vw, vh * 16 / 9)) + 'px';
    placeScreen();
    // the laptop from the top of the lid to the front of the keys: under the heading, and under the closing line
    // with the call to action below it
    const lx = (GLASS.l - .06) * W, lw = (GLASS.r - GLASS.l + .12) * W, ly = .04 * H, lh = .7 * H;
    const side = phone ? r * 1.6 : r * 4;
    base = fit(lx, ly, lw, lh, side, head.offsetTop + head.offsetHeight + r * 3.2, vw - side, vh - r * 1.6, 1);
    close = fit(lx, ly, lw, lh, side, outro.offsetTop + outro.offsetHeight + r * 3.2, vw - side, end.offsetTop - r * 2.4, 1);
    const top = r * 10, bottom = pill.offsetTop - r * 2.4, gap = r * 4;
    caps.forEach((cap, i) => {
      const box = spots[i] = measure(cap);
      let L = r * 4, R = vw - r * 4, T = top, B = bottom;
      if (phone) { L = r * 2.4; R = vw - r * 2.4; T = r * 10.6; B = cap.offsetTop - r * 2.4; }
      else if (cap.dataset.side === 'left') L = cap.offsetLeft + cap.offsetWidth + gap;
      else R = cap.offsetLeft - gap;
      views[i] = fit(GLASS.l * W + box.x * ss, GLASS.t * H + box.y * ss, box.w * ss, box.h * ss, L, T, R, B, phone ? 6 : 2.6);
    });
  };

  // ---------- showing a step: classes and one transform; CSS runs the motion ----------
  const viewOf = k => (isStep(k) ? views[k - 1] : k === CLOSE ? close : base);
  const shotOf = k => (isStep(k) ? caps[k - 1].dataset.shot : k === CLOSE ? 'recovery' : 'overview');
  let at = -1, spotTimer = 0;
  const aim = () => { const v = viewOf(at); stage.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`; };
  const drawSpot = () => {
    const { x, y, w, h } = spots[at - 1], r = rem() * 1.6, W = screen.offsetWidth, H = screen.offsetHeight;
    veil.setAttribute('d', `M0 0H${W}V${H}H0Z M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - h}a${r} ${r} 0 0 1 ${r} ${-r}Z`);
  };
  const setStep = k => {
    if (k === at) return;
    at = k;
    aim();
    showShot(shotOf(k));
    setSettled(isStep(k) ? caps[k - 1].hasAttribute('data-settled') : k === CLOSE);
    caps.forEach((c, i) => c.classList.toggle('is-on', i === k - 1));
    sec.classList.toggle('at-intro', k === 0);
    sec.classList.toggle('at-steps', isStep(k));
    sec.classList.toggle('at-close', k === CLOSE);
    // the spotlight fades out, moves while unseen, and fades back in on the new spot as the view lands
    spot.classList.remove('is-on');
    clearTimeout(spotTimer);
    if (isStep(k)) spotTimer = setTimeout(() => { drawSpot(); spot.classList.add('is-on'); }, 380);
    pills.forEach((b, n) => {
      b.classList.toggle('is-current', n === k - 1);
      b.classList.toggle('is-done', n < k - 1);
      b.toggleAttribute('aria-current', n === k - 1);
    });
  };

  // a jump (step bar, Skip): the page scrolls there and the steps it passes are skipped, not played
  let target = null;
  const scrollTo = (y, k, done) => {
    target = k;
    if (k !== null) setStep(k);
    lenis.scrollTo(y, { duration: 1, force: true, onComplete: () => { target = null; done?.(); onScroll(); } });
  };
  pills.forEach((b, i) => b.addEventListener('click', () => scrollTo(posY(i + 1), i + 1)));

  // ---------- Skip: past the whole laptop, the way the page was heading when it came up ----------
  const skipper = document.createElement('button');
  skipper.type = 'button';
  skipper.className = 'wt-skipper';
  skipper.innerHTML = '<span>Skip<span class="wt-skipper-long"> the walkthrough</span></span><svg aria-hidden="true"><use href="#i-arrow"/></svg>';
  document.body.append(skipper);
  let skipWay = 0, skipping = false;   // 1 down, -1 up, 0 hidden
  const showSkip = way => {
    if (way === skipWay) return;
    skipWay = way;
    skipper.classList.toggle('is-shown', !!way);
    if (!way) return;
    skipper.dataset.way = way > 0 ? 'down' : 'up';
    skipper.setAttribute('aria-label', way > 0 ? 'Skip the laptop walkthrough and continue down the page' : 'Skip the laptop walkthrough and go back up the page');
  };
  skipper.addEventListener('click', () => {
    const way = skipWay || 1;
    skipping = true;
    showSkip(0);
    scrollTo(way > 0 ? docTop(sec) + sec.offsetHeight : docTop(sec) - innerHeight, way > 0 ? CLOSE : 0, () => { skipping = false; });
  });

  // ---------- the scroll: which step, whether pinned, whether Skip shows ----------
  let held = false;
  const onScroll = () => {
    const p = pos(), hold = p >= 0 && p <= LEN;
    if (hold !== held) {   // the nav keeps its full size, and goes solid, while the laptop holds the screen
      held = hold;
      sec.classList.toggle('is-pinned', hold);
      nav?.classList.toggle('is-held', hold);
    }
    if (target === null) setStep(stepAt(p));
    if (skipping) return;
    if (p <= -.75 || p >= LEN + .85) showSkip(0);
    else if (!skipWay) showSkip(p < LEN / 2 ? 1 : -1);   // arriving from above it goes on down; from below, back up
  };

  // the still: fetched once the section is a screen and a half away, and decoded before the laptop rises in
  let ready = false, seen = false;
  const rise = () => { if (ready && seen) sec.classList.add('is-in'); };
  new IntersectionObserver((es, io) => {
    if (!es.some(e => e.isIntersecting)) return;
    io.disconnect();
    const img = new Image();
    img.src = stillUrl;
    img.decode().catch(() => {}).then(() => { still.src = stillUrl; ready = true; rise(); });
  }, { rootMargin: '150% 0px' }).observe(sec);
  new IntersectionObserver((es, io) => { if (es.some(e => e.isIntersecting)) { seen = true; rise(); io.disconnect(); } }, { threshold: .25 }).observe(pin);

  sec.style.setProperty('--wt-len', LEN.toFixed(3));
  sec.classList.add('is-live');
  lenis.resize();   // the page just grew by the section's scroll length
  layout();
  setStep(0);
  void stage.offsetWidth;   // the first view is placed, not animated in
  sec.classList.add('is-ready');

  ScrollTrigger.create({
    trigger: sec, start: () => docTop(sec) - innerHeight, end: () => docTop(sec) + sec.offsetHeight, invalidateOnRefresh: true,
    onUpdate: onScroll,
    onToggle: self => { if (!self.isActive && !skipping) showSkip(0); },
  });
  ScrollTrigger.addEventListener('refreshInit', layout);
  ScrollTrigger.addEventListener('refresh', () => {   // a resize: the same step, measured again
    aim();
    if (isStep(at)) drawSpot();
    onScroll();
  });
});
