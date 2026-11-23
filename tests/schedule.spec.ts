// Regression suite for the block-2 collision: "Line 1 of block 2 loses its slot and restarts
// together with Line 2".
//
// Root cause: the auto-reschedule anchored the next start on `Date.now()` of whichever client
// happened to notice the expiry. A tab that woke up late saw several lines as expired in one tick
// and handed them all the SAME slot. The fix anchors on each line's own previous start, so the
// result no longer depends on when it is observed.
//
// Tests 1, 2 and 4 drive the slot maths directly through the page's `window.__sched` hook, so they
// assert the real shipped functions without waiting out 30-minute sessions. Test 3 exercises the
// compare-and-swap write against the real database.

import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { ensureLines, waitSeeded } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });
function track(a: Actor): Actor { actors.push(a); return a; }

const MIN = 60_000;

// Runs the page's real scheduling maths with a chosen session duration.
// `startOffsetsMin` are minutes relative to a 5-minute grid point at/just before "now", so a
// negative offset means "this line started that many minutes ago and is overdue".
async function slotsFor(
  admin: Actor,
  opts: { sessionMin: number; gapMin: number; startOffsetsMin: number[] },
) {
  return admin.page.evaluate(({ sessionMin, gapMin, startOffsetsMin }) => {
    const s = (window as any).__sched;
    const prev = s.totalSessionTime;
    s.totalSessionTime = sessionMin * 60000;
    try {
      // A 5-minute grid point at or just before now, so results land on the grid.
      const d = new Date(s.serverNow());
      d.setSeconds(0, 0);
      d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
      const base = d.getTime();
      return {
        base,
        now: s.serverNow(),
        starts: startOffsetsMin.map((m) => base + m * 60000),
        slots: startOffsetsMin.map((m) => s.nextStartForLine(base + m * 60000, gapMin)),
      };
    } finally {
      s.totalSessionTime = prev;
    }
  }, opts);
}

test('1. the block schedule is generated, and the answer never depends on when it is observed', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitSeeded();

  // Three lines staggered 10 min apart (the real 20:00 / 20:10 / 20:20 block 1), 30-min sessions
  // with a 5-min gap -> a 35-minute cycle per line.
  const { base, slots } = await slotsFor(admin, { sessionMin: 30, gapMin: 5, startOffsetsMin: [0, 10, 20] });

  // Block 2 is exactly block 1 + 35 min, which is the published 20:35 / 20:45 / 20:55.
  expect(slots).toEqual([base + 35 * MIN, base + 45 * MIN, base + 55 * MIN]);

  // Idempotency: evaluating the same line repeatedly over a few hundred ms (the tick fires at
  // 200 ms, and a throttled tab can be a full minute late) must not move the answer.
  const repeated: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await slotsFor(admin, { sessionMin: 30, gapMin: 5, startOffsetsMin: [0] });
    repeated.push(r.slots[0] - r.base);
    await admin.page.waitForTimeout(120);
  }
  expect(new Set(repeated).size).toBe(1);
});

test('2. THE INCIDENT: one tick seeing two expired lines must not give them the same slot', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitSeeded();

  // The exact state behind the reported screenshot: at 20:40 a woken tab saw Line 1 (started
  // 20:00, 40 min ago, nobody had advanced it) and Line 2 (started 20:10, just expired) as expired
  // in the SAME tick. The old code gave both "20:45".
  const { starts, slots } = await slotsFor(admin, {
    sessionMin: 30, gapMin: 5, startOffsetsMin: [-40, -30, -20],
  });

  expect(new Set(slots).size).toBe(3);          // no two lines share a slot
  expect(slots[0]).not.toBe(slots[1]);          // Line 1 does not land on Line 2's slot
  expect(slots[1] - starts[1]).toBe(35 * MIN);  // Line 2 gets its real next slot (20:45)
});

test('3. a stale client cannot clobber a line another client already advanced', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineA] = await ensureLines(admin, 2);

  // Another client has advanced this line to 21:45. Our tab still believes it reads "20:35" —
  // precisely the state a tab resuming from sleep is in.
  await oracle.putValue(`config/lines/${lineA}/time`, '21:45');
  await waitFor(() => oracle.read(`config/lines/${lineA}/time`), (t) => t === '21:45', 8000);

  const result = await admin.page.evaluate(({ lineId }) => {
    const s = (window as any).__sched;
    return new Promise<any>((resolve) => {
      const cfg = { id: lineId, name: 'Line under test', time: '20:35' };
      s.commitReschedule(lineId, cfg, '20:35', '20:45');
      // The transaction round-trips to the server; sample the local view afterwards.
      setTimeout(() => resolve({ localTime: cfg.time }), 6000);
    });
  }, { lineId: lineA });

  // The compare-and-swap saw "21:45" where this tab expected "20:35", so it aborted: the stored
  // value is untouched and the stale tab did not adopt its own write either.
  expect(await oracle.read(`config/lines/${lineA}/time`)).toBe('21:45');
  expect(result.localTime).toBe('20:35');

  // The aborted attempt is recorded — this is the fingerprint of a tab acting on a stale view,
  // and the reason the next incident is diagnosable from data rather than from a photo.
  const log = (await oracle.read('log')) || {};
  const entries = Object.values(log) as any[];
  const abort = entries.find((e) => e.lineId === lineA && e.from === '20:35' && e.committed === false);
  expect(abort, `no aborted-reschedule entry in /log: ${JSON.stringify(entries)}`).toBeTruthy();
  expect(typeof abort.clientId).toBe('string');
  expect(typeof abort.at).toBe('number');    // server timestamp, not the client's clock
  expect(abort.to).toBe('20:45');

  // And no two lines share a start time.
  const times = (await oracle.lines()).map((l) => l.time).filter(Boolean);
  expect(new Set(times).size).toBe(times.length);
});

test('5. a line really does advance itself, and the advance is audited', async ({ browser }) => {
  test.setTimeout(170_000);
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineA] = await ensureLines(admin, 1);

  // One-minute sessions so the line expires while the test watches.
  await oracle.patchConfig({ sessionDuration: '1', autoReschedule: '5' });
  await waitFor(() => oracle.read('config/sessionDuration'), (v) => v === '1', 8000);

  const started = await oracle.makeLineActiveNow(lineA);
  const advanced = await waitFor(
    () => oracle.read(`config/lines/${lineA}/time`),
    (t) => !!t && t !== started,
    120_000,
  );
  expect(advanced).not.toBe(started);

  const log = (await oracle.read('log')) || {};
  const entries = Object.values(log) as any[];
  expect(entries.some((e) => e.lineId === lineA && e.from === started && e.to === advanced && e.committed === true)).toBe(true);
});

test('4. a line that misses a slot keeps its phase instead of jumping onto the next free one', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitSeeded();

  // Started 40 min ago with a 35-minute cycle: its 35-min slot has already passed.
  const { starts, slots } = await slotsFor(admin, { sessionMin: 30, gapMin: 5, startOffsetsMin: [-40] });
  const cycle = 35 * MIN;

  expect((slots[0] - starts[0]) % cycle).toBe(0);     // still on its own grid
  expect(slots[0] - starts[0]).toBe(2 * cycle);       // skipped one cycle, did not creep forward
  expect(slots[0]).toBeGreaterThan(Date.now());
});
