# Speed-Chat realistic simulation tests

Multi-actor, browser-driven simulation of real event usage. Each test spins up several **real browser
sessions** (Playwright browser contexts) — admins and viewers — that drive the actual UI while we
inject **real network failures** (offline, slow-3G, latency). Assertions are made against an
independent **DB oracle** that reads Firebase back over REST, so we prove what actually persisted, not
just what one screen optimistically showed.

## ⚠️ It runs against PROD Firebase `/state`

By design (the app is stateless — `/state` is disposable event scratch). The suite **clears `/state`
before and after** each run. A guard prevents accidents:

- You must set `RUN_AGAINST_PROD=1`.
- **Do not run during a live event** — it wipes `/state`.

## Install (one time)

```bash
npm install
npx playwright install chromium
```

## Run against the FIXED app (pre-deploy gate)

Serves the working-tree `index.html` locally; it still talks to prod Firebase.

```bash
RUN_AGAINST_PROD=1 npm test                 # all scenarios
RUN_AGAINST_PROD=1 npx playwright test sync.spec.ts     # just the sync proofs
RUN_AGAINST_PROD=1 npx playwright test -g "2. "         # one scenario
npx playwright show-report                   # open the HTML report + traces
```

## Run against the CURRENT UNFIXED app (before/after evidence)

The pinned pre-fix snapshot lives at `tests/fixtures/index.unfixed.html` (git `f407c20`). Copy it to
the repo root (the root copy is git-ignored) and point the suite at it:

```bash
cp tests/fixtures/index.unfixed.html index.unfixed.html
RUN_AGAINST_PROD=1 APP_PAGE=/index.unfixed.html npx playwright test sync.spec.ts alarm.spec.ts
```

The concurrency / general-queue / manual-alarm scenarios FAIL here (that's the point — they reproduce
the reported bugs), and PASS against the fixed app.

## Run against the deployed PROD URL (post-deploy smoke)

```bash
RUN_AGAINST_PROD=1 BASE_URL=https://cirogamboa.github.io/speed-chat APP_PAGE=/ npx playwright test sync.spec.ts
```

## What each file is

- `lib/actor.ts` — one browser session (role, audio instrumentation, console-error capture, UI
  helpers, network chaos controls).
- `lib/dbOracle.ts` — reads/writes the real DB over REST; shape-agnostic (keyed objects and legacy
  arrays), so the same assertions work for fixed and unfixed runs.
- `lib/scenario.ts` — small setup helpers (seed wait, create lines).
- `static-server.mjs` — concurrent static file server (python's http.server stalls under parallel
  requests from many contexts).
- `global-setup.ts` / `global-teardown.ts` — clear `/state`; enforce the `RUN_AGAINST_PROD` guard.
- `*.spec.ts` — the ten scenarios (sync, resilience, alarm, soak).

Tests run **serially** (`workers: 1`) because they share the single `/state` node.
