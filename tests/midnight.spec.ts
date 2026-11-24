// Regression tests for resolving a bare "HH:MM" across midnight.
//
// parseTime() used to place the label on TODAY unconditionally. generateTimeOptions() offers slots
// two hours ahead and crosses into the next day, so a 00:05 slot offered at 23:32 resolved 23.5
// hours into the PAST: the line read as expired, auto-reschedule 'off' cleared its time, and the
// operator's selection silently blanked out. Between 22:00 and midnight -- prime event time -- the
// tail of the dropdown was unusable.
//
// These are deliberately written to be DETERMINISTIC AT EVERY HOUR. The offsets are expressed
// relative to the current time rather than as literal clock values, so none of them is a test that
// only works near midnight -- which is exactly the trap that let this bug survive.
import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

/** The app's own parseTime, via the diag hook, plus the server clock it resolves against. */
async function resolve(a: Actor, hhmm: string): Promise<{ at: number; now: number }> {
  return a.page.evaluate((t) => {
    const s = (window as any).__sched;
    return { at: s.parseTime(t), now: s.serverNow() };
  }, hhmm);
}

async function hhmmOffsetFromServer(a: Actor, offsetMinutes: number): Promise<string> {
  return a.page.evaluate((mins) => {
    const s = (window as any).__sched;
    return s.formatTime(new Date(s.serverNow() + mins * 60_000));
  }, offsetMinutes);
}

const HOUR = 60 * 60 * 1000;

test('60. a label thirteen hours "past" is read as tomorrow, not as long expired', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin', query: 'diag=1' }));

  // 13h back wraps the clock, so naively it lands 13h in the past; the nearest real occurrence is
  // 11h ahead. Works at every hour of the day, which is the point.
  const label = await hhmmOffsetFromServer(admin, -13 * 60);
  const { at, now } = await resolve(admin, label);

  expect(at).toBeGreaterThan(now);
  expect(at - now).toBeGreaterThan(10 * HOUR);
  expect(at - now).toBeLessThan(12 * HOUR);
});

test('61. a genuinely recent past time stays in the past', async ({ browser }) => {
  // The other half of the contract, and the one a careless fix breaks: a line that started two
  // hours ago is running or just finished, and must NOT be pushed to tomorrow.
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin', query: 'diag=1' }));

  const label = await hhmmOffsetFromServer(admin, -2 * 60);
  const { at, now } = await resolve(admin, label);

  expect(at).toBeLessThan(now);
  expect(now - at).toBeGreaterThan(HOUR);
  expect(now - at).toBeLessThan(3 * HOUR);
});

test('62. a near-future time is untouched', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin', query: 'diag=1' }));

  const label = await hhmmOffsetFromServer(admin, 90);
  const { at, now } = await resolve(admin, label);

  expect(at).toBeGreaterThan(now);
  expect(at - now).toBeLessThan(2 * HOUR);
});

test('63. every slot the dropdown offers resolves into the future', async ({ browser }) => {
  // The invariant that was actually violated. The app must never offer a start time it will then
  // treat as already gone, at any hour.
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin', query: 'diag=1' }));
  const [lineId] = await ensureLines(admin, 1);

  const options = (await admin.page.locator(`#time${lineId} option`).allTextContents())
    .filter((t) => /^\d{2}:\d{2}$/.test(t));
  expect(options.length).toBeGreaterThanOrEqual(24);

  for (const label of options) {
    const { at, now } = await resolve(admin, label);
    expect(at, `slot ${label} must not resolve into the past`).toBeGreaterThanOrEqual(now - 60_000);
    expect(at - now, `slot ${label} must be within the two-hour horizon`).toBeLessThan(2.2 * HOUR);
  }
});

test('64. a start time chosen across midnight survives instead of blanking out', async ({ browser }) => {
  // End to end, through the real control: pick the LAST slot the dropdown offers -- the one most
  // likely to have wrapped -- and confirm the app keeps it rather than clearing it as expired.
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin', query: 'diag=1' }));
  const [lineId] = await ensureLines(admin, 1);
  await oracle.patchConfig({ sessionDuration: '30', autoReschedule: 'off', blinkTime: '5' });

  const select = admin.page.locator(`#time${lineId}`);
  const options = (await select.locator('option').allTextContents()).filter((t) => /^\d{2}:\d{2}$/.test(t));
  const chosen = options[options.length - 1];

  await select.selectOption(chosen);
  await waitFor(() => oracle.lines(), (ls) => (ls.find((l) => l.id === lineId)?.time ?? '') === chosen, 10_000);

  // Give the tick loop several passes to clear it, which is what used to happen.
  await admin.page.waitForTimeout(2000);

  const line = (await oracle.lines()).find((l) => l.id === lineId)!;
  expect(line.time, 'the chosen time must not be cleared as if already expired').toBe(chosen);
  await expect(admin.page.locator('#timers-container .timer .count')).toContainText(/Starting in/);
});
