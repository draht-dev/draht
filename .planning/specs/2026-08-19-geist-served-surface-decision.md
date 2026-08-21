# DR-01 — The one daemon-served surface

> **Status:** accepted, 2026-08-19. **Requirement:** R32-FLEET.10.
> **Resolves:** `.planning/specs/2026-08-18-geist-remote-control-rev8.md` §10 Q1 and §10 Q2.
> **Binding on:** every renderer acceptance from Phase 32 onward.
> The bundle this record decides is `packages/geist-console/bundle/`, and it links back here.

## The two questions, answered

**Q1 — "Does the desktop renderer reuse `geist-console` (React) or the existing `packages/web-ui`?"**

> **`geist-console` — the package. Not its React/Vite app.** The served surface is one
> buildless, dependency-free ES-module bundle in `packages/geist-console/bundle/`, served by
> the daemon at `/ui`. `packages/web-ui` is rejected outright.

**Q2 — "Is Adler (external Flutter client) usable as the mobile renderer, or is a
gateway-served web UI the faster path to a working phone surface?"**

> **Adler is not the mobile renderer.** The same bundle from Q1 is the phone surface. It is
> not a second build, a second codebase, or a second layout — one document, one stylesheet,
> one script, responsive at both viewports.

## Why `web-ui` is rejected (Q1)

Three findings, each checked against the tree rather than remembered:

1. **It would re-privilege draht through the renderer.** `packages/web-ui/package.json`
   depends on `@draht/agent-core`, `@draht/ai` and `@draht/tui`. R32-FLEET.1 exists so that
   geist's product logic carries no kernel dependency and Phase 38 is a host swap; adopting a
   kernel-importing renderer would hand that back at the UI layer. `check-geist-boundary.mjs`
   would fail the moment `web-ui` were pulled into the geist family, and routing around the
   gate by leaving it outside the family is the same mistake wearing a different directory.
2. **It cannot be served without a build.** Its `build` is `tsc -p tsconfig.build.json &&
   tailwindcss -i ./src/app.css -o ./dist/app.css --minify`, and its `main` is `dist/index.js`.
   A renderer acceptance that first has to run Tailwind is a renderer acceptance that will be
   skipped.
3. **It speaks the wrong wire.** `web-ui` renders `@draht/ai` message objects. The fleet
   surface renders `geist-protocol` frames — `fleet`, `output`, `input_echo`,
   `session_metadata`, `error`, `protocol_error`. There is no shared type between them, so
   "reuse" would mean rewriting the data layer and keeping the CSS.

## Why not the React/Vite app already in `geist-console` (Q1)

The package is the right home — spec §7 already assigns it the desktop renderer — but its
current contents are an M1 stub: `src/App.tsx` renders the single word "geist" behind Vite,
React 19, `@vitejs/plugin-react` and `@types/react`.

The disqualifier is a hard constraint, not a preference: **the daemon serves this bundle, and
the browser harness must load it from the running daemon with no build step.** A Vite app is a
`dist/` that has to exist first. That means either a build in the acceptance's `before` hook —
minutes of wall clock, and a class-3 proof that no longer drives what the daemon actually has
on disk — or a build artifact committed to the tree, which is the drift the corpus gate exists
to prevent everywhere else.

Plain ES modules make the served file and the source file the same bytes. There is nothing to
regenerate, nothing to keep in sync, and the harness proves the literal file that ships.

The React stub is left in place and untouched; it is not on the served path. Removing it is a
separate change with its own test, not a side effect of this one.

## Why Adler is not the mobile renderer (Q2)

1. **It is not in this repository.** `packages/gateway/README.md:130` points at
   `github.com/draht-dev/adler`. R32-FLEET.12 requires that every renderer acceptance from
   Phase 32 onward be a DOM assertion that runs in CI. An out-of-tree Flutter app cannot be
   loaded by `scripts/browser-harness.mjs`, cannot be version-locked to a `geist/0.x` bump, and
   cannot fail root `npm run check` when the wire drifts. Adopting it would make the phone
   surface exactly the thing §8 forbids: a claim with no evidence class above 1.
2. **It consumes the wire being retired.** `packages/gateway/.planning/attachable-sessions-prd.md`
   shows Adler attaching through the gateway's raw-stdout session wire with `clientId:
   "adler-abc123"`. Spec §7 retires that wire in favour of geist-protocol, and R32-FLEET.8
   deletes the `POST /sessions {command}` path in this same phase. Adler would need a port to
   the new protocol *and* a hand-maintained mirror gate of its own — the `quest/` arrangement,
   for a client nobody in this phase can run.
3. **The flagship mobile job is not shipped by a second client.** Spec §5.2 names B5,
   permission relay, as the reason the mobile surface justifies its existence. That lands in
   Phase 34 on `permission_request`/`permission_answer`. One bundle means it ships once.

Adler is not deprecated by this record. It remains a legitimate third-party consumer of the
protocol; it is simply not the surface Phase 32 through 34 acceptance runs against.

## The decision, stated so it can be violated

- **One bundle.** `packages/geist-console/bundle/{index.html,console.css,console.js}`. No
  build step, no framework, no npm dependency, no request off this machine. The daemon serves
  those three files plus `packages/geist-console/src/tokens.css` — **the same file** the
  geist-picker overlay uses, not a copy — under `GET /ui`. A fifth route,
  `GET /ui/protocol.json`, renders `GEIST_PROTOCOL_FAMILY` and `GEIST_PROTOCOL_VERSION` from
  the same `@draht/geist-protocol` constants the daemon validates frames with, so the bundle
  writes down no protocol literal of its own and a `0.x` bump cannot leave the served page
  speaking a superseded handshake.
- **Two viewports, one document.** Desktop (≥ 720 px) lays the fleet rail and the session
  transcript side by side. Below 720 px the same DOM becomes one column: the fleet is the
  screen, opening a session replaces it, a back control returns. There is no phone-only branch
  in the JavaScript — `body[data-view]` plus one media query, so the two viewports cannot drift
  apart in behaviour.
- **Tokens from the first pixel.** Every colour in `console.css` is a `var(--…)` resolved by
  `tokens.css`, which is linked in `<head>` before the script tag. There is no moment where
  the page renders unstyled and no hardcoded hex in the bundle.
- **The bundle is the phone surface.** Phase 33 exposes this same file through
  `tailscale serve`; Phase 34 adds permission cards to this same file. A desktop-only layout
  now is rework later, so it is not built.

## The sub-decision this forced: how a browser authenticates

Not asked in §10, but unavoidable — and it is the one place a wrong choice would have made the
bundle rework in Phase 33.

A browser cannot put an `Authorization` header on a document navigation, and
`new WebSocket(url)` takes no headers at all. The gateway's `bearerAuthMiddleware` therefore
still carries a `?token=` query fallback whose comment says it exists "since WebSocket upgrades
can't always carry custom headers from browsers". **R33-REACH.3 deletes that fallback**, and
spec §6.4 forbids tokens in query strings outright. A bundle built on it would break next
phase.

Resolved as follows, and every clause was measured in a real headless Chromium before it was
written down:

1. **`/ui` and its three assets are served unauthenticated.** They are static, contain no
   secret, and the daemon is loopback-bound. The data surface is untouched: `GET /fleet` and
   `GET /attach` still answer 401 without a credential — proven in the same acceptance run that
   loads the page.
2. **The credential arrives in the URL *fragment*** — `/ui#token=…`. A fragment is never sent
   to the server, never reaches an access log, and never appears in a `Referer`. The bundle
   moves it to `sessionStorage` and strips it from the address bar with `history.replaceState`
   on the first tick. This is the shape R33-REACH.4's QR deep link already needs.
3. **`GET /fleet` uses `Authorization: Bearer`.** Ordinary header auth; `fetch` can set it.
4. **`GET /attach` carries the credential in `Sec-WebSocket-Protocol`** — a request *header*,
   not a query string — as `geist.bearer.<base64url(token)>`. Measured, not assumed:
   - Chromium sends the requested subprotocol as `sec-websocket-protocol` on the upgrade
     request, where Hono middleware reads it like any other header;
   - Bun echoes the requested subprotocol back on the 101, which RFC 6455 requires or the
     browser fails the connection — so this works through `hono/bun`'s `upgradeWebSocket`,
     which passes no `headers` of its own;
   - **base64url is required, not decoration.** A raw base64 token is rejected by the browser
     before a byte leaves it:
     `SyntaxError: Failed to construct 'WebSocket': The subprotocol
     'geist.bearer.aGVsbG8/d29ybGQ=' is invalid` — `/` and `=` are not RFC 7230 tchars. The
     base64url alphabet is. The acceptance run therefore uses a token containing `+`, `/` and
     `=` so a regression here cannot pass.
5. **The upgrade-request refusal posture is unchanged.** Auth still runs on the upgrade
   request, so an unauthenticated attach is still refused before any Unix socket is opened
   (R32-FLEET.3). This adds a second *header* the middleware accepts; it removes nothing and
   weakens nothing. The `?token=` fallback stays exactly as it is — deleting it is
   R33-REACH.3's job, and after that deletion this bundle keeps working unchanged.

## Consequences

- `packages/gateway` gains a `@draht/geist-console` workspace dependency and one 60-line
  wiring route. The bundle's asset list lives in `geist-console`, so the daemon does not know
  what is in it.
- The bundle is a client of the protocol, so it is bound by the `check:geist-protocol` corpus
  gate the same way the daemon is: a `0.x` bump that changes a frame the bundle reads breaks
  the browser acceptance, in the browser, with the rendered DOM in the failure message.
- `scripts/geist-console-bundle.e2e.test.mjs` is the acceptance and runs in root `npm test`.
  It drives the emitted `draht` binary and the daemon's own bin, over HTTP and WS only, in a
  real browser, at 1280×800 and 390×844.
