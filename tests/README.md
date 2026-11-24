# Speed-Chat realistic simulation tests

Multi-actor, browser-driven simulation of real event usage. Each test spins up several **real browser
sessions** (Playwright browser contexts) — admins and viewers — that drive the actual UI while we
inject **real network failures** (offline, slow-3G, latency). Assertions are made against an
independent **DB oracle** that reads Firebase back over REST, so we prove what actually persisted, not
just what one screen optimistically showed.

## It runs in an isolated DB namespace, not `/state`

The suite uses the `test_ci` top-level node, never the live `/state`. The app is pointed at it with
its own `?stateNs=` parameter, which `Actor.create` appends automatically, and the oracle reads and
writes the same node — so **running the tests cannot touch live event data**, and the suite is safe
to run as a pre-event check.

Two guards in `global-setup.ts` enforce it:

- It **refuses to run** if `STATE_NS` resolves to `state`, unless you deliberately set
  `RUN_AGAINST_PROD=1`.
- It **refuses** the frozen `index.unfixed.html` fixture in an isolated namespace: that snapshot
  predates `?stateNs=` and would write to `/state` whatever the URL says. Running the before/after
  comparison needs `STATE_NS=state RUN_AGAINST_PROD=1 APP_PAGE=/index.unfixed.html`, and **that
  combination does wipe `/state`** — do not do it during a live event.

The `test_ci` node needs a matching rule in `database.rules.json`; it is published alongside the
`state` rule.

### If the whole suite suddenly fails with `401 Permission denied`

Every browser context signs in anonymously, so one full run creates on the order of a hundred
anonymous Firebase users, and Firebase rate-limits anonymous sign-up **per IP**. Running the suite
several times back to back can exhaust that quota; the oracle then cannot get a token, its writes
are rejected, and `global-setup` fails before a single test runs — with no output other than the
401.

It is transient. Wait a few minutes and re-run. To confirm that is what you are looking at:

```bash
curl -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=$FIREBASE_API_KEY" -H 'Content-Type: application/json' --data '{"returnSecureToken":true}'
```

An `error` with `TOO_MANY_ATTEMPTS_TRY_LATER` confirms the quota; a returned `idToken` means the
problem is something else.

## Install (one time)

```bash
npm install
npx playwright install chromium
```

## Run against the FIXED app (pre-deploy gate)

Serves the working-tree `index.html` locally; it still talks to prod Firebase.

```bash
npm test                                    # all scenarios (isolated namespace)
npx playwright test sync.spec.ts            # just the sync proofs
npx playwright test -g "2. "                # one scenario
npx playwright show-report                   # open the HTML report + traces
```

## Run against the CURRENT UNFIXED app (before/after evidence)

The pinned pre-fix snapshot lives at `tests/fixtures/index.unfixed.html` (git `f407c20`). Copy it to
the repo root (the root copy is git-ignored) and point the suite at it:

```bash
cp tests/fixtures/index.unfixed.html index.unfixed.html
STATE_NS=state RUN_AGAINST_PROD=1 APP_PAGE=/index.unfixed.html npx playwright test sync.spec.ts alarm.spec.ts
```

The concurrency / general-queue / manual-alarm scenarios FAIL here (that's the point — they reproduce
the reported bugs), and PASS against the fixed app.

## Run against the deployed PROD URL (post-deploy smoke)

```bash
BASE_URL=https://cirogamboa.github.io/speed-chat APP_PAGE=/ npx playwright test sync.spec.ts
```

## What each file is

- `lib/actor.ts` — one browser session (role, audio instrumentation, console-error capture, UI
  helpers, network chaos controls).
- `lib/dbOracle.ts` — reads/writes the real DB over REST; shape-agnostic (keyed objects and legacy
  arrays), so the same assertions work for fixed and unfixed runs.
- `lib/scenario.ts` — small setup helpers (seed wait, create lines).
- `static-server.mjs` — concurrent static file server (python's http.server stalls under parallel
  requests from many contexts).
- `global-setup.ts` / `global-teardown.ts` — pick and clear the isolated `test_ci` namespace;
  refuse prod and refuse the unfixed fixture unless explicitly asked for.
- `*.spec.ts` — the ten scenarios (sync, resilience, alarm, soak).

Tests run **serially** (`workers: 1`) because they share the single `/state` node.
