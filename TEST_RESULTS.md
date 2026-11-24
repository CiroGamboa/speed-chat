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

**Also validated 10/10 against the LIVE deployed site** (`https://cirogamboa.github.io/speed-chat`) +
prod Firebase — the true end-to-end post-deploy run:
`RUN_AGAINST_PROD=1 BASE_URL=https://cirogamboa.github.io/speed-chat npx playwright test`.

## Alarm audio run — 18/18 passed (2.2m)

Added after several events where the rotation banner appeared on time but the speaker stayed
silent, and nobody could tell it had broken. Root cause: browsers block audio until the page is
clicked, and the password modal is skipped once `localStorage` records a verified password — so a
venue screen that is left untouched can run all night without ever being allowed to make a sound.
Re-pairing the Bluetooth speaker "fixed" it because walking over and clicking the Chrome window
*is* the gesture the browser was waiting for.

```
✓ 7  alarm still fires at the interval boundary under churn        fires      (25.6s)
✓ 8  manual alarm plays even when the toggle is OFF                 plays      (2.7s)
✓ 11 a screen nobody clicks says out loud it cannot make a sound    warns      (2.2s)
✓ 12 the toggle gates the 30s warning and the alarm together        unified    (3.6s)
✓ 13 the banner outlives the audio element, ignores stray 'ended'   holds      (6.4s)
✓ 14 every ring builds a fresh playback instance                    3 distinct (5.4s)
✓ 15 a device change is logged, recovered, and un-confirms sound    recovers   (2.3s)
✓ 16 keep-alive runs while a round is active, stops when none is    lifecycle  (3.9s)
✓ 17 a dead primary path escalates instead of going silent          escalates  (3.2s)
✓ 18 the diagnostics log survives a reload                          persists   (4.0s)
+ the 8 pre-existing sync/resilience/soak scenarios, all still green.
```

Command: `TEST_PORT=8111 RUN_AGAINST_PROD=1 npx playwright test` → 18 passed (2.2m).

The suite is sensitive to network conditions: during this work several runs failed wholesale with
`UND_ERR_CONNECT_TIMEOUT` against `chill-speed-chat-default-rtdb.firebaseio.com`, and a stale
server left on port 8080 by an interrupted run produced cascades of `ERR_CONNECTION_REFUSED`.
Neither is an app fault. `TEST_PORT` now exists so a stuck port can be stepped around; if a run
fails broadly, check Firebase reachability before suspecting the code.

### What these tests cannot cover

Real audibility is not provable from a browser — nothing in JS can see the Windows per-app volume
mixer, which endpoint the audio actually landed on, or whether the speaker is awake. So the suite
proves the pipeline runs, escalates and reports; it does **not** prove a noise reached the room.
That is what the operator's **Test sound → did you hear it?** check is for, and why the status
badge never claims "sound OK" on its own. Also untested headless, by design: WASAPI rebinding,
the `setSinkId` round-trip, and Bluetooth standby/wake latency. See `AUDIO_TROUBLESHOOTING.md`.

## Note on the capacity guard

The plan called for a Firebase transaction to enforce the per-line cap under concurrency. Real testing
showed transactions are unreliable across offline/reconnect (they dropped ~3/60 writes during the
chaos soak). Because **not losing a logged person matters more than a hard cap**, adds now use a
granular `set()` on a unique key (offline-safe, never clobbers) with a best-effort client-side cap
check. Concurrency tests still show exact, zero-loss counts; the cap is a soft UI guard (as it always
effectively was).
