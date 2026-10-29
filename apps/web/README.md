# apps/web

The site. Phase 0: static (landing, login, preloader) — served by the API locally, by Netlify in production. Phase 5: this directory becomes the Next.js 15 app; the preloader, tokens, and bar carry over unchanged.

## The preloader (O4)

`preloader.css` + `preloader.js` — the AntherBrackets ACT-1 intro, renamed for Jatin (operator directive; the Drive template itself is not used). Bar drop, line-masked char-slam, hold, scatter, curtain — mechanics and easings ported from the source's `night/motion.js` (glide `0.62,0.05,0.01,0.99`, slam `0.2,1.4,0.3,1`, power3.out).

- **No-JS safe**: the cover is created by JS; without it, the page is never covered.
- **Reduced motion**: a fade, not a slam.
- **Watchdog**: the page is revealed even if the timeline dies or throws.
- **Handoff seam**: the curtain carries a clone of the site bar (same markup, same styles) — the lift is one continuous surface.

## Type

Bricolage Grotesque (variable 200–800) + IBM Plex Mono — self-hosted in `fonts/`, SIL OFL 1.1 (licence text ships per family). Amends the plan's original Fraunces/Inter per the operator's loader directive; if the Operator prefers other faces, swap the `@font-face` rules and the `--jt-disp`/`--jt-mono` tokens — nothing else names a font.

## Pages

- `index.html` — landing (Phase 0 stub; Phase 12 rewrites, not replaces the bones)
- `login.html` — username + password, sign in / create account (O3: created accounts are pending operator verification)
