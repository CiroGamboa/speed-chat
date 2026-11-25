import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });
let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });
function track(a: Actor): Actor { actors.push(a); return a; }

test('7. the alarm still fires at the interval boundary WHILE other users are logging (churn)', async ({ browser }) => {
  test.setTimeout(140_000);
  const watcher = track(await Actor.create(browser, { label: 'watcher', role: 'admin' }));
  const churner = track(await Actor.create(browser, { label: 'churner', role: 'admin' }));

  const ids = await ensureLines(watcher, 1);
  // 1-minute alarm interval, 10-minute session, line active as of this minute.
  await oracle.patchConfig({ alarmInterval: '1', sessionDuration: '10', maxPeoplePerLine: '100' });
  await oracle.makeLineActiveNow(ids[0]);

  // Let both clients ingest the config/time, then snapshot the baseline alarm count.
  await watcher.page.waitForTimeout(1500);
  const baseline = await watcher.alarmPlayCount('bell');

  // Generate continuous sync traffic across the boundary — this is exactly what used to
  // rebuild the timers and swallow the alarm in the old code.
  let stop = false;
  const churn = (async () => {
    let i = 0;
    while (!stop) {
      await churner.addPersonToLine(0, `churn-${i++}`).catch(() => {});
      await churner.page.waitForTimeout(400);
    }
  })();

  // Within ~75s (<= one full interval) the main alarm must ring at least once on the watcher.
  await expect
    .poll(() => watcher.alarmPlayCount('bell'), { timeout: 80_000, intervals: [1000] })
    .toBeGreaterThan(baseline);

  stop = true;
  await churn;

  // The on-screen "change seats" notification also showed.
  expect(await watcher.notificationVisible()).toBe(true);
  expect(watcher.appErrors(), watcher.appErrors().join('\n')).toEqual([]);
});

test('8. the manual alarm button plays even when the alarm toggle is OFF', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitFor(() => oracle.read(''), (s) => !!(s && s.timestamp), 10000);

  await admin.setAlarmToggle(false);
  const before = await admin.alarmPlayCount('bell');

  await admin.clickManualAlarm();

  await expect.poll(() => admin.alarmPlayCount('bell'), { timeout: 8000 }).toBe(before + 1);
});

// ---------------------------------------------------------------------------
// Audio-output regressions. These exist because the venue team hit "the banner
// appears on time but nothing comes out of the speaker" across several events,
// and nothing in the app ever said so.
// ---------------------------------------------------------------------------

test('11. a screen nobody clicks says out loud that it cannot make a sound', async ({ browser }) => {
  // The venue PC verified the password months ago, so the modal never shows again and the
  // display can run all night with zero user gestures. That is the un-armed state: the old
  // code showed the rotation banner and stayed silent without a word of warning.
  const screen = track(await Actor.create(browser, {
    label: 'untouched-screen', role: 'viewer', seedPasswordFlag: true, skipArmingClick: true,
  }));
  await screen.page.waitForTimeout(1500);

  const health = await screen.audioHealth();
  expect(health, 'AlarmAudio must publish its health').not.toBeNull();
  expect(health.armed, 'a page with no user gesture must not claim to be armed').toBe(false);
  expect(await screen.armBannerVisible()).toBe(true);
  expect(await screen.audioBadgeText()).toContain('NOT ARMED');

  // A rotation on an un-armed screen must still show, and must be recorded as silent.
  // Driven through the rotation path rather than the manual button: that button is now the
  // sound check and ARMS the output first, so it no longer reproduces an un-armed screen.
  await screen.fireRotationAlarm();
  await expect.poll(() => screen.notificationVisible(), { timeout: 8000 }).toBe(true);
  await expect
    .poll(async () => (await screen.alarmLogEvents('ring.result')).map((d: any) => d.detail), { timeout: 8000 })
    .toContain('not-armed');

  expect(screen.appErrors(), screen.appErrors().join('\n')).toEqual([]);
});

test('12. the alarm toggle gates the 30-second warning and the rotation alarm together', async ({ browser }) => {
  // These used to read two different sources of truth (the checkbox vs a localStorage-backed
  // variable). A silenced 30s warning is also what leaves a Bluetooth speaker asleep for the
  // whole five minutes before a rotation.
  const a = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitFor(() => oracle.read(''), (s) => !!(s && s.timestamp), 10000);
  await a.waitForArmed();

  await a.setAlarmToggle(false);
  const offBell = await a.alarmPlayCount('bell');
  const offWarn = await a.alarmPlayCount('bell30s');
  await a.page.evaluate(() => {
    (window as any).showChangeSeatNotification();
    (window as any).showThirtySecondAlarm();
  });
  await a.page.waitForTimeout(1200);
  expect(await a.alarmPlayCount('bell'), 'toggle OFF must silence the rotation alarm').toBe(offBell);
  expect(await a.alarmPlayCount('bell30s'), 'toggle OFF must silence the 30s warning').toBe(offWarn);

  await a.setAlarmToggle(true);
  await a.page.evaluate(() => {
    (window as any).showChangeSeatNotification();
    (window as any).showThirtySecondAlarm();
  });
  await expect.poll(() => a.alarmPlayCount('bell'), { timeout: 8000 }).toBe(offBell + 1);
  await expect.poll(() => a.alarmPlayCount('bell30s'), { timeout: 8000 }).toBe(offWarn + 1);
  expect(await a.warn30Visible(), 'the 30s warning must have a visual of its own').toBe(true);
});

test('13. the rotation banner outlives the audio element and ignores a stray "ended"', async ({ browser }) => {
  // The old code hid the banner from an 'ended' listener attached inside the play() resolve
  // handler of a SHARED element. Those listeners accumulated over a multi-hour event, so a
  // later unrelated 'ended' could wipe a banner that had only just gone up.
  const a = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitFor(() => oracle.read(''), (s) => !!(s && s.timestamp), 10000);

  await a.clickManualAlarm();
  await expect.poll(() => a.notificationVisible(), { timeout: 8000 }).toBe(true);

  // Fire 'ended' from an unrelated element carrying the same id.
  await a.page.evaluate(() => {
    const stray = new Audio();
    stray.id = 'bell';
    stray.dispatchEvent(new Event('ended'));
    document.getElementById('bell')?.dispatchEvent(new Event('ended'));
  });
  await a.page.waitForTimeout(500);
  expect(await a.notificationVisible(), 'a stray "ended" must not hide the banner').toBe(true);

  // And it must still be up well past the old 3-second timeout.
  await a.page.waitForTimeout(3500);
  expect(await a.notificationVisible()).toBe(true);
});

test('14. every ring builds a fresh playback instance (never a wedged, reused one)', async ({ browser }) => {
  // A single long-lived <audio> element keeps whatever output sink it was given. When that
  // sink dies — Bluetooth re-route, endpoint invalidation — it stays dead for the rest of
  // the event, which is what re-pairing the speaker was really fixing.
  const a = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitFor(() => oracle.read(''), (s) => !!(s && s.timestamp), 10000);

  await a.waitForArmed();
  const before = (await a.audioHealth()).instances;
  for (let i = 0; i < 3; i++) {
    await a.clickManualAlarm();
    await a.page.waitForTimeout(900);
  }
  const rings = await a.alarmLogEvents('ring');
  const instances = rings.map((d: any) => d.instance);
  expect(instances.length).toBeGreaterThanOrEqual(3);
  // Strictly increasing: no instance is ever reused.
  for (let i = 1; i < instances.length; i++) expect(instances[i]).toBeGreaterThan(instances[i - 1]);
  expect((await a.audioHealth()).instances).toBeGreaterThanOrEqual(before + 3);
});

test('15. an output-device change is logged, recovered from, and un-confirms the sound', async ({ browser }) => {
  const a = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitFor(() => oracle.read(''), (s) => !!(s && s.timestamp), 10000);

  await a.waitForArmed();

  // Pretend the operator confirmed they heard it, then yank the output device.
  await a.page.evaluate(() => (window as any).AlarmAudio.confirmHeard(true));
  expect((await a.audioHealth()).heardAt).toBeTruthy();

  await a.dispatchDeviceChange();
  await expect.poll(() => a.alarmLogEvents('devicechange'), { timeout: 5000 }).not.toEqual([]);
  // Nothing in JS can see which speaker the audio landed on, so a device change must drop
  // the "confirmed" claim rather than keep asserting the sound is fine.
  await expect.poll(async () => (await a.audioHealth()).heardAt, { timeout: 5000 }).toBeFalsy();

  // And the alarm must still ring afterwards.
  const before = await a.alarmPlayCount('bell');
  await a.clickManualAlarm();
  await expect.poll(() => a.alarmPlayCount('bell'), { timeout: 8000 }).toBe(before + 1);
  expect(a.appErrors(), a.appErrors().join('\n')).toEqual([]);
});

test('16. the keep-alive runs while a round is active and stops when none is', async ({ browser }) => {
  // Chromium swaps a sink fed with silence for a fake one, and re-opening costs a Bluetooth
  // speaker seconds of A2DP restart — long enough to swallow the start of the alarm.
  const a = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const ids = await ensureLines(a, 1);
  await oracle.patchConfig({ alarmInterval: '5', sessionDuration: '10' });
  await oracle.makeLineActiveNow(ids[0]);

  await expect.poll(async () => (await a.audioHealth()).keepAlive, { timeout: 20_000 }).toBe(true);

  // Unschedule the line through the database, exactly as the app does when a round ends.
  // Auto-reschedule has to go first, or the app simply books the line in again.
  await oracle.patchConfig({ autoReschedule: 'off' });
  await oracle.putValue(`config/lines/${ids[0]}/time`, '');
  await expect.poll(async () => (await a.audioHealth()).keepAlive, { timeout: 20_000 }).toBe(false);
});

test('17. when the primary audio path dies the alarm escalates instead of going silent', async ({ browser }) => {
  const a = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitFor(() => oracle.read(''), (s) => !!(s && s.timestamp), 10000);

  await a.waitForArmed();
  await a.forceAudioFailure({ failPrimary: true });
  await a.clickManualAlarm();

  await expect
    .poll(async () => (await a.alarmLogEvents('ring.path')).map((d: any) => `${d.path}:${d.status}`), { timeout: 8000 })
    .toContain('buffer:failed');
  // The element attempt is only logged once it has been verified, a moment later.
  await expect
    .poll(async () => (await a.alarmLogEvents('ring.path')).map((d: any) => d.path), { timeout: 8000 })
    .toContain('element');
  expect(a.appErrors(), 'handled audio failures must not be logged as console errors').toEqual([]);
});

test('18. the diagnostics log survives the reload an operator reaches for first', async ({ browser }) => {
  const a = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await waitFor(() => oracle.read(''), (s) => !!(s && s.timestamp), 10000);

  await a.clickManualAlarm();
  // Wait for the RING specifically to reach storage, not merely for the key to be non-empty.
  //
  // The old gate polled for length > 10, which is satisfied the instant the page boots: by the
  // time the manual alarm fires, this key already holds kilobytes of startup entries
  // (ctx.created, clip.fetched, arm.ok...). It resolved in 3-76ms every run and gated nothing,
  // so whether the test passed came down to whether the click happened to land inside the
  // first 2s persist window -- which in turn depended on how long Firebase anonymous sign-in
  // took. Throttled auth meant a slow test meant a late click meant a failure, which read as
  // flakiness with no connection to the thing under test.
  await expect
    .poll(
      () => a.page.evaluate(() => (localStorage.getItem('speedchat_alarm_log') || '').includes('"event":"ring"')),
      { timeout: 15000 },
    )
    .toBe(true);

  await a.page.reload({ waitUntil: 'domcontentloaded' });
  await a.page.waitForTimeout(1200);

  const stored = await a.page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('speedchat_alarm_log') || '[]'); } catch (e) { return []; }
  });
  expect(Array.isArray(stored) && stored.length, 'evidence must outlive a reload').toBeTruthy();

  const text = await a.page.evaluate(() => (window as any).AlarmAudio.diagnosticsText());
  expect(text).toContain('alarm audio diagnostics');
  expect(text).toContain('ring');
});
