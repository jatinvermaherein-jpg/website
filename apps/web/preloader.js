/* ────────────────────────────────────────────────────────────────
 * Jatin preloader — the AntherBrackets ACT-1 intro, renamed.
 *
 * Sequence (port, timings unchanged):
 *   0.00  the bar drops in            (0.6s, glide)
 *   0.10  the word slams up through   (1.05s per char, slam,
 *         the line mask, random            0.03s stagger)
 *         ±8° of rotation
 *   0.25  eyebrow and hint follow     (0.7s, power3.out)
 *   ~1.6  the hold — the reader lands on the mark
 *   then  the word pulls apart        (0.9s, the source page does
 *                                     this on scroll; here it is
 *                                     the curtain's own crossing)
 *   then  the curtain lifts           (0.7s, glide)
 *
 * No dependencies. The cover is created here — a page without
 * scripting is never covered. Reduced motion gets a fade, not a
 * slam. A watchdog reveals the page even if the timeline dies,
 * and a thrown animation reveals it too.
 * ──────────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  if (typeof document === "undefined" || typeof window === "undefined") return;

  /* ── easings (ported from night/motion.js) ─────────────────── */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    function solve(x) {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const e = sx(t) - x;
        if (Math.abs(e) < 1e-5) return t;
        const d = dx(t);
        if (Math.abs(d) < 1e-6) break;
        t -= e / d;
      }
      let lo = 0, hi = 1;
      t = x;
      while (hi - lo > 1e-5) {
        if (sx(t) < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return t;
    }
    return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)));
  }
  const glide = bezier(0.62, 0.05, 0.01, 0.99);
  const slam = bezier(0.2, 1.4, 0.3, 1);
  const out3 = (t) => 1 - Math.pow(1 - t, 3);
  const lin = (t) => t;
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const rand = (a, b) => a + Math.random() * (b - a);

  /* ── one tween: seconds in, seconds out ────────────────────── */
  function animate(dur, ease, step, delay = 0) {
    return new Promise((resolve) => {
      const t0 = performance.now() + delay * 1000;
      const frame = (now) => {
        const k = (now - t0) / (dur * 1000);
        if (k < 0) { requestAnimationFrame(frame); return; }
        if (k >= 1) { step(1); resolve(); return; }
        step(ease(k));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* wrap each char of each .jt-line in its own span; the lean word
     stays whole so its slant and colour survive the split */
  function splitChars(type) {
    const chars = [];
    type.querySelectorAll(".jt-line").forEach((line) => {
      line.querySelectorAll(".jt-word").forEach((word) => {
        const text = word.textContent || "";
        word.textContent = "";
        for (const ch of text) {
          const s = document.createElement("span");
          s.className = "jt-char";
          s.textContent = ch === " " ? "\u00A0" : ch;
          word.appendChild(s);
          chars.push(s);
        }
      });
    });
    return chars;
  }

  const BAR_HTML = `
    <a class="jt-brand" href="/" aria-label="Jatin, home">
      <svg class="jt-mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
        <circle cx="16" cy="16" r="11" opacity="0.25"/>
        <circle cx="16" cy="16" r="7" opacity="0.5"/>
        <circle class="jt-mark-core" cx="16" cy="16" r="3.4"/>
      </svg>
      <span>Jatin<i></i></span>
    </a>
    <nav class="jt-nav" aria-label="Site">
      <a href="/#flow">Flow</a><a href="/#crew">Crew</a><a href="/#pricing">Pricing</a><a href="/#docs">Docs</a>
      <a class="jt-cta" href="/login.html">Sign in</a>
    </nav>`;

  function buildCover() {
    const cover = document.createElement("div");
    cover.className = "jt-cover";
    cover.setAttribute("aria-hidden", "true");
    cover.innerHTML = `
      <header class="jt-bar jt-bar--cover"><div class="jt-bar-in">${BAR_HTML}</div></header>
      <div class="jt-stage">
        <div>
          <p class="jt-eyebrow">One pool &middot; many models &mdash; one crew &middot; many seats</p>
          <h1 class="jt-type">
            <span class="jt-line jt-line--thin"><span class="jt-word">Every drop,</span></span>
            <span class="jt-line"><span class="jt-word">one</span>&nbsp;<span class="jt-word jt-lean">pearl.</span></span>
          </h1>
          <p class="jt-hint">every key, at full burn &mdash; one gateway</p>
        </div>
      </div>
      <div class="jt-veil"></div>
      <div class="jt-grain"></div>`;
    return cover;
  }

  async function runSequence(cover, reduced) {
    const bar = cover.querySelector(".jt-bar");
    const eyebrow = cover.querySelector(".jt-eyebrow");
    const hint = cover.querySelector(".jt-hint");
    const chars = splitChars(cover.querySelector(".jt-type"));

    if (reduced) {
      bar.style.transform = "none";
      chars.forEach((c) => { c.style.transform = "none"; c.style.opacity = "0"; });
      eyebrow.style.opacity = "0";
      hint.style.opacity = "0";
      await sleep(120);
      await animate(0.5, lin, (k) => chars.forEach((c) => (c.style.opacity = String(k))));
      await animate(0.4, lin, (k) => { eyebrow.style.opacity = String(k); hint.style.opacity = String(k); });
      await sleep(700);
      await animate(0.5, lin, (k) => (cover.style.opacity = String(1 - k)));
      return;
    }

    /* hold the from-state before the first frame */
    bar.style.transform = "translateY(-100%)";
    const rot0 = chars.map(() => rand(-8, 8));
    const tx0 = chars.map(() => rand(-34, 34));
    const ty0 = chars.map(() => rand(-16, 16));
    const tr0 = chars.map(() => rand(-14, 14));
    chars.forEach((c, i) => (c.style.transform = `translateY(116%) rotate(${rot0[i]}deg)`));
    eyebrow.style.opacity = "0";
    eyebrow.style.transform = "translateY(26px)";
    hint.style.opacity = "0";
    hint.style.transform = "translateY(26px)";

    const charDur = 1.05;
    const stagger = 0.03;
    const total = 0.1 + charDur + stagger * (chars.length - 1);

    await Promise.all([
      animate(0.6, glide, (k) => (bar.style.transform = `translateY(${(-100 + 100 * k)}%)`)),
      animate(total, lin, (k) => {
        const T = k * total - 0.1;
        chars.forEach((c, i) => {
          const e = slam(clamp01((T - i * stagger) / charDur));
          c.style.transform = `translateY(${(116 - 116 * e)}%) rotate(${rot0[i] * (1 - e)}deg)`;
        });
      }),
    ]);

    await Promise.all([
      animate(0.7, out3, (k) => {
        eyebrow.style.opacity = String(k);
        eyebrow.style.transform = `translateY(${(26 - 26 * k)}px)`;
      }, 0.15),
      animate(0.7, out3, (k) => {
        hint.style.opacity = String(k);
        hint.style.transform = `translateY(${(26 - 26 * k)}px)`;
      }, 0.25),
    ]);

    /* the hold */
    await sleep(380);

    /* the word pulls apart — the source page does this on scroll;
       here it is the curtain's own crossing */
    await animate(0.9, lin, (k) => {
      chars.forEach((c, i) => {
        c.style.transform = `translate(${tx0[i] * k}%, ${ty0[i] * k}%) rotate(${tr0[i] * k}deg)`;
        c.style.opacity = String(1 - k);
      });
      eyebrow.style.opacity = String(1 - k);
      hint.style.opacity = String(1 - k);
    });

    /* the curtain lifts */
    await animate(0.7, glide, (k) => (cover.style.transform = `translateY(${(-100 * k)}%)`));
  }

  let cover = null;
  let active = false;

  function reveal() {
    if (!cover || !active) return;
    active = false;
    cover.classList.add("is-gone");
    document.documentElement.classList.remove("jt-locked");
    sleep(450).then(() => {
      if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
      cover = null;
    });
  }

  function init() {
    if (active) return;
    active = true;
    document.documentElement.classList.add("jt-locked");
    cover = buildCover();
    document.body.appendChild(cover);

    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const watchdog = setTimeout(reveal, 5000); /* nothing holds the page hostage */
    runSequence(cover, reduced)
      .then(() => { clearTimeout(watchdog); reveal(); })
      .catch(() => { clearTimeout(watchdog); reveal(); }); /* a thrown animation never leaves the page covered */
  }

  function replay() {
    if (cover) {
      active = false;
      cover.classList.add("is-gone");
      setTimeout(init, 60);
    } else {
      init();
    }
  }

  window.__jatinPreloader = { init, replay, version: "1.0.0" };
})();
