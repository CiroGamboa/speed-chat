// Regression suite for the block-2 collision: "Line 1 of block 2 loses its slot and restarts
// together with Line 2".
//
// Root cause: the auto-reschedule anchored the next start on `Date.now()` of whichever client
// happened to notice the expiry. A tab that woke up late saw several lines as expired in one tick
// and handed them all the SAME slot. The fix anchors on each line's own previous start, so the
// result no longer depends on when it is observed.
//
// Tests 1, 2 and 4 drive the slot maths directly through the page's `window.__sched` hook, so they
// assert the real shipped functions without waiting out 30-minute sessions. Tests 3, 5 and 6
// exercise the write path and the staleness guard against the real database.

import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { ensureLines, waitSeeded } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });
function track(a: Actor): Actor { actors.push(a); return a; }

const MIN = 60_000;

// Polls /log until `predicate` holds, then returns the entries (or the last read, so a failing
// assertion can print what was actually there).
async function logEntries(predicate: (entries: any[]) => boolean, timeoutMs = 20_000): Promise<any[]> {
  return waitFor(
    async () => Object.values((await oracle.read('log')) || {}) as any[],
    predicate,
    timeoutMs,
  );
}

// `diag=1` is what makes the app expose window.__sched on a non-localhost deployment.
async function admin(browser: any, label = 'admin'): Promise<Actor> {
  return track(await Actor.create(browser, { label, role: 'admin', query: 'diag=1' }));
}

// Runs the page's real scheduling maths with a chosen session duration.
// `startOffsetsMin` are minutes relative to a 5-minute grid point at/just before "now", so a
// negative offset means "this line started that many minutes ago and is overdue".
async function slotsFor(
  a: Actor,
  opts: { sessionMin: number; gapMin: number; startOffsetsMin: number[] },
) {
  return a.page.evaluate(({ sessionMin, gapMin, startOffsetsMin }) => {
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
        starts: startOffsetsMin.map((m) => base + m * 60000),
        slots: startOffsetsMin.map((m) => s.nextStartForLine(base + m * 60000, gapMin)),
      };
    } finally {
      s.totalSessionTime = prev;
    }
  }, opts);
}

test('1. the block schedule is generated, and the answer never depends on when it is observed', async ({ browser }) => {
  const a = await admin(browser);
  await waitSeeded();

  // Three lines staggered 10 min apart (the real 20:00 / 20:10 / 20:20 block 1), 30-min sessions
  // with a 5-min gap -> a 35-minute cycle per line.
  const { base, slots } = await slotsFor(a, { sessionMin: 30, gapMin: 5, startOffsetsMin: [0, 10, 20] });

  // Block 2 is exactly block 1 + 35 min, which is the published 20:35 / 20:45 / 20:55.
  expect(slots).toEqual([base + 35 * MIN, base + 45 * MIN, base + 55 * MIN]);

  // Idempotency: evaluating the same line repeatedly over a few hundred ms (the tick fires at
  // 200 ms, and a throttled tab can be a full minute late) must not move the answer.
  const repeated: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await slotsFor(a, { sessionMin: 30, gapMin: 5, startOffsetsMin: [0] });
    repeated.push(r.slots[0] - r.base);
    await a.page.waitForTimeout(120);
  }
  expect(new Set(repeated).size).toBe(1);
});

test('2. THE INCIDENT: one tick seeing two expired lines must not give them the same slot', async ({ browser }) => {
  const a = await admin(browser);
  await waitSeeded();

  // The exact state behind the reported screenshot: at 20:40 a woken tab saw Line 1 (started
  // 20:00, 40 min ago, nobody had advanced it) and Line 2 (started 20:10, just expired) as expired
  // in the SAME tick. The old code gave both "20:45".
  const { starts, slots } = await slotsFor(a, {
    sessionMin: 30, gapMin: 5, startOffsetsMin: [-40, -30, -20],
  });

  expect(new Set(slots).size).toBe(3);          // no two lines share a slot
  expect(slots[0]).not.toBe(slots[1]);          // Line 1 does not land on Line 2's slot
  expect(slots[1] - starts[1]).toBe(35 * MIN);  // Line 2 gets its real next slot (20:45)
});

test('3. a stale client cannot clobber a line another client already advanced', async ({ browser }) => {
  const a = await admin(browser);
  const [lineA] = await ensureLines(a, 2);

  // Long session, no auto-reschedule: the line is RUNNING, so the app leaves its time alone for
  // the duration of the test and the only writer is the compare-and-swap below.
  await oracle.patchConfig({ sessionDuration: '60', autoReschedule: 'off' });
  await waitFor(() => oracle.read('config/sessionDuration'), (v) => v === '60', 8000);
  const current = await oracle.makeLineActiveNow(lineA);

  // Our tab believes the line still reads "20:35" — precisely the state a tab resuming from sleep
  // is in, while another client has moved it on.
  const result = await a.page.evaluate(({ lineId }) => {
    const s = (window as any).__sched;
    return new Promise<any>((resolve) => {
      const cfg = { id: lineId, name: 'Line under test', time: '20:35' };
      s.commitReschedule(lineId, cfg, '20:35', '20:45');
      // The transaction round-trips to the server; sample the local view afterwards.
      setTimeout(() => resolve({ localTime: cfg.time }), 6000);
    });
  }, { lineId: lineA });

  // The compare-and-swap saw the real value where this tab expected "20:35", so it aborted: the
  // stored value is untouched and the stale tab did not adopt its own write either.
  expect(await oracle.read(`config/lines/${lineA}/time`)).toBe(current);
  expect(result.localTime).toBe('20:35');

  // The aborted attempt is recorded — this is the fingerprint of a tab acting on a stale view,
  // and the reason the next incident is diagnosable from data rather than from a photo.
  const entries = await logEntries((es) => es.some((e) => e.lineId === lineA && e.committed === false));
  const abort = entries.find((e) => e.lineId === lineA && e.from === '20:35' && e.committed === false);
  expect(abort, `no aborted-reschedule entry in /log: ${JSON.stringify(entries)}`).toBeTruthy();
  expect(typeof abort.clientId).toBe('string');
  expect(typeof abort.at).toBe('number');    // server timestamp, not the client's clock
  expect(abort.to).toBe('20:45');

  // And no two lines share a start time.
  const times = (await oracle.lines()).map((l) => l.time).filter(Boolean);
  expect(new Set(times).size).toBe(times.length);
});

test('4. a line that misses a slot keeps its phase instead of jumping onto the next free one', async ({ browser }) => {
  const a = await admin(browser);
  await waitSeeded();

  // Started 40 min ago with a 35-minute cycle: its 35-min slot has already passed.
  const { starts, slots } = await slotsFor(a, { sessionMin: 30, gapMin: 5, startOffsetsMin: [-40] });
  const cycle = 35 * MIN;

  expect((slots[0] - starts[0]) % cycle).toBe(0);     // still on its own grid
  expect(slots[0] - starts[0]).toBe(2 * cycle);       // skipped one cycle, did not creep forward
  expect(slots[0]).toBeGreaterThan(Date.now());
});

// Doubles as the regression test for a bug found reviewing the first version of this fix.
// Staleness used to be derived from the TICK CADENCE: a gap >5s between ticks suppressed
// rescheduling until a snapshot landed. But the snapshot handler ticks immediately, so on a tab
// whose timers are throttled (Chrome gives hidden tabs one callback per minute) that very tick
// re-armed the suppression before doing any work — rescheduling was permanently dead, and with
// every writer tab backgrounded the lines simply stopped advancing. Staleness now comes from the
// RTDB connection, which is what actually tells us whether our view is current. Hence: forced tick
// gap, must still advance.
test('5. a line advances itself and is audited, even on a tab whose ticks are minutes apart', async ({ browser }) => {
  const a = await admin(browser);
  const [lineA] = await ensureLines(a, 1);

  // One-minute sessions so a line that started now is overdue within the minute.
  await oracle.patchConfig({ sessionDuration: '1', autoReschedule: '5' });
  await waitFor(() => oracle.read('config/sessionDuration'), (v) => v === '1', 8000);

  // Make every tick look like it followed a ten-minute pause, the way an intensively throttled
  // background tab does. A connected tab must still be free to reschedule.
  await a.page.evaluate(() => {
    (window as any).__gapTimer = setInterval(() => (window as any).__sched.forceTickGap(600_000), 100);
  });
  expect(await a.page.evaluate(() => (window as any).__sched.scheduleViewIsStale())).toBe(false);

  const started = await oracle.makeLineActiveNow(lineA);
  const advanced = await waitFor(
    () => oracle.read(`config/lines/${lineA}/time`),
    (t) => !!t && t !== started,
    90_000,
  );
  expect(advanced).not.toBe(started);

  await a.page.evaluate(() => clearInterval((window as any).__gapTimer));

  // The log push rides in the same transaction callback as the write we just observed, so poll
  // rather than read once — the REST read of `time` can win the race against it.
  const entries = await logEntries((es) => es.some((e) => e.lineId === lineA && e.committed === true));
  const committed = entries.filter((e) => e.lineId === lineA && e.committed === true);
  expect(committed, `no committed reschedule in /log: ${JSON.stringify(entries)}`).not.toHaveLength(0);
  expect(committed.map((e) => e.to)).toContain(advanced);
});

test('6. an offline tab is treated as stale, and recovers once it has re-synced', async ({ browser }) => {
  const a = await admin(browser);
  await ensureLines(a, 1);

  const stale = () => a.page.evaluate(() => (window as any).__sched.scheduleViewIsStale());
  expect(await stale()).toBe(false);

  // Offline: we cannot know whether another client has advanced a line, so we must not write.
  await a.goOffline();
  await expect.poll(stale, { timeout: 20_000 }).toBe(true);

  // Back online and re-synced: free to reschedule again.
  await a.goOnline();
  await expect.poll(stale, { timeout: 30_000 }).toBe(false);
});

// Regression test for the pre-sign-in write window, which only became reachable once the
// locked-down rules ('.write': 'auth != null') were published. Anonymous sign-in takes ~1s and the
// SDK does NOT hold writes until the token is attached, so a write issued in that window is
// rejected outright. The password is cached in localStorage, so a returning device skips the modal
// and can click inside it. Stalling the sign-in round-trip makes the window wide and deterministic.
// Without dbWrite's retry, the person never lands and the add is silently lost.
test('7. a click made before sign-in completes is retried, not swallowed', async ({ browser }) => {
  test.setTimeout(120_000);

  // Seed through a normal admin: the page's own seed waits on authReady, which the stalled actor
  // below will not reach for several seconds.
  const setup = await admin(browser, 'setup');
  const [lineA] = await ensureLines(setup, 1);
  await oracle.patchConfig({ maxPeoplePerLine: '10' });

  const STALL = 6000;
  const slow = track(await Actor.create(browser, {
    label: 'slow-auth', role: 'admin', query: 'diag=1', stallAuthMs: STALL,
  }));

  // By construction this click happens while sign-in is still in flight.
  await slow.addPersonToLine(0, 'Window Tester');

  const people = await waitFor(
    async () => ((await oracle.lines()).find((l) => l.id === lineA)?.people ?? []) as any[],
    (ps: any[]) => ps.some((p) => p && p.name === 'Window Tester'),
    STALL + 30_000,
  );

  // It landed...
  expect(people.map((p: any) => p.name)).toContain('Window Tester');

  // ...via the retry, not because the write happened to succeed (which is what would happen if the
  // rules were still public). This is the assertion that makes the test meaningful.
  expect(
    slow.logs.filter((l) => /retrying after auth/i.test(l)),
    `no retry log — the write was never denied, so this test proved nothing. Logs:\n${slow.logs.join('\n')}`,
  ).not.toHaveLength(0);

  // And exactly once: the retry must not duplicate the person.
  expect(people.filter((p: any) => p.name === 'Window Tester')).toHaveLength(1);
});
