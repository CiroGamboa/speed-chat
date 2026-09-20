# Test results — sync & alarm reliability

Realistic, multi-actor, browser-driven simulation against the **real prod app + prod Firebase
`/state`**. Each scenario runs several real browser sessions (admins + viewers), injects real network
failures (offline, slow-3G, latency), and asserts against an independent DB oracle (reads Firebase
back over REST — proves what actually persisted, not what one screen showed).

How to reproduce: see `tests/README.md`. All runs used `RUN_AGAINST_PROD=1`.

## Before / after

The same suite was run against the **unfixed** app (`index.unfixed.html`, git `f407c20`) and the
**fixed** app (working-tree `index.html`).

| # | Scenario | Unfixed (before) | Fixed (after) |
|---|----------|------------------|----------------|
| 2 | Concurrent logging on the SAME line (expect 36) | ❌ **10/36** — 26 lost | ✅ **36/36** |
| 3 | Concurrent logging on DIFFERENT lines (expect 30) | ❌ **10/30** — 20 lost | ✅ **30/30** |
| 4 | Per-line wait queue does NOT wipe the general queue | ❌ general queue wiped | ✅ intact |
| 5 | Offline admin reconnects — no writes lost (expect 6) | ❌ **3/6** — half clobbered | ✅ **6/6** merged |
| 8 | Manual alarm plays even when the toggle is OFF | ❌ silent (0 extra plays) | ✅ plays |
| 9 | Two admins add a line at once → two distinct lines | ❌ **1** line (id collision) | ✅ **2** distinct |
| 1 | A logged person propagates to other sessions | ✅ pass | ✅ pass |
| 6 | High-latency actor still converges | — | ✅ 10/10 |
| 7 | Alarm still fires at the interval boundary under churn | — | ✅ fires |
| 10 | Chaos soak: 4 admins + offline flaps (expect 60) | — | ✅ 60/60 |

**Before run:** `APP_PAGE=/index.unfixed.html` → 6 failed (the reproduced bugs).
**After run:** working-tree `index.html` → 10 passed.
(Scenarios 6/7/10 weren't re-run against the unfixed app — 7 & 10 are long and timing-based; the
numeric loss in 2/3/5 is the decisive proof of the same root cause.)

## Fixed-app run (detail) — 10/10 passed (1.4m)

```
✓ 1  a logged person propagates to other sessions                         (2.9s)
✓ 2  concurrent logging on the SAME line loses nobody          36/36      (2.8s)
✓ 3  concurrent logging on DIFFERENT lines all persists        30/30      (3.0s)
✓ 4  per-line wait queue does NOT wipe the general queue        intact     (2.3s)
✓ 5  offline admin reconnects — no writes lost (merges)         6/6        (3.3s)
✓ 6  high-latency actor still converges                         10/10      (2.5s)
✓ 7  alarm still fires at the interval boundary under churn     fires      (47.9s)
✓ 8  manual alarm plays even when the toggle is OFF             plays      (1.5s)
✓ 9  two admins add a line at once → two distinct lines         2 distinct (2.0s)
✓ 10 chaos soak: 4 admins + offline flaps, zero lost writes     60/60      (14.2s)
```

Run against the working-tree `index.html` (local server) → prod Firebase `/state`.
Command: `RUN_AGAINST_PROD=1 npx playwright test`.

## Note on the capacity guard

The plan called for a Firebase transaction to enforce the per-line cap under concurrency. Real testing
showed transactions are unreliable across offline/reconnect (they dropped ~3/60 writes during the
chaos soak). Because **not losing a logged person matters more than a hard cap**, adds now use a
granular `set()` on a unique key (offline-safe, never clobbers) with a best-effort client-side cap
check. Concurrency tests still show exact, zero-loss counts; the cap is a soft UI guard (as it always
effectively was).
