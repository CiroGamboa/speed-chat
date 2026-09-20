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
