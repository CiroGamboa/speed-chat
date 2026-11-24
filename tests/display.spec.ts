// Characterisation tests for the timer card's display states -- the big countdown everyone in the
// room is looking at, and the most restyle-sensitive code in the app.
//
// These are PURE RENDER OUTPUT: tickOneLine() sets .count's text and toggles .starting-text,
// .lounge-text, .blinking, .finish-window, .active and .inactive. Before this file not one of them
// was asserted anywhere, so a repaint could have silently killed "This line's time is over" or
// the pre-start blink and nothing would have failed until an event.
//
// Every state is reached by writing a start time through the oracle rather than by waiting, so
// the whole file runs in seconds.
import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

const timer = (a: Actor) => a.page.locator('#timers-container .timer').first();
const count = (a: Actor) => timer(a).locator('.count');
const panel = (a: Actor) => a.page.locator('#timers-container .people-panel').first();

// toHaveClass(cls('active')) also matches "inactive" -- it is a substring test, not a word test. Every
// state class below is matched as a whole token so the two cannot be confused.
const cls = (name: string) => new RegExp(`(?:^|\\s)${name}(?:$|\\s)`);

// The app reparses an "HH:MM" string onto TODAY using server time, so offsets are expressed the
// same way the operator would type them. Minutes are clamped well away from midnight by the
// callers below; a run started within ~an hour of 00:00 would need date-aware fixtures.
function hhmmFromNow(offsetMinutes: number): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function lineShowing(a: Actor, lineId: string, time: string, config: Record<string, string> = {}) {
  if (Object.keys(config).length) await oracle.patchConfig(config);
  await oracle.putValue(`config/lines/${lineId}/time`, time);
  // Wait for the tick to repaint from the new snapshot rather than asserting on the old frame.
  await a.page.waitForTimeout(600);
}

test('36. a line scheduled in the future counts down to its start time', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  // 30 min out, with blink at 5, so it is waiting but NOT yet blinking.
  await lineShowing(admin, lineId, hhmmFromNow(30), { blinkTime: '5', sessionDuration: '30' });

  await expect(count(admin)).toHaveClass(cls('starting-text'));
  await expect(count(admin)).toContainText(/Starting in \d+ min/);
  await expect(count(admin).locator('.scheduled-time')).toHaveText(hhmmFromNow(30));
  await expect(timer(admin)).toHaveClass(cls('inactive'));
  await expect(timer(admin)).not.toHaveClass(cls('blinking'));
  await expect(timer(admin)).not.toHaveClass(cls('finish-window'));
});

test('37. a line inside the blink window blinks; outside it does not', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  await lineShowing(admin, lineId, hhmmFromNow(3), { blinkTime: '10', sessionDuration: '30' });
  await expect(timer(admin)).toHaveClass(cls('blinking'));

  // Same line, pushed beyond the window: the class must come back off, not just fail to reapply.
  await lineShowing(admin, lineId, hhmmFromNow(40), { blinkTime: '5' });
  await expect(timer(admin)).not.toHaveClass(cls('blinking'));
});

test('38. a running line shows MM:SS and is active', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  // Started 2 min ago, 60 min long, finish window 5 -- comfortably mid-session.
  await lineShowing(admin, lineId, hhmmFromNow(-2), {
    sessionDuration: '60', finishWindow: '5', autoReschedule: 'off',
  });

  await expect(timer(admin)).toHaveClass(cls('active'));
  await expect(count(admin)).toHaveText(/^\d{2}:\d{2}$/);
  await expect(count(admin)).not.toHaveClass(cls('starting-text'));
  await expect(count(admin)).not.toHaveClass(cls('lounge-text'));
  await expect(timer(admin)).not.toHaveClass(cls('finish-window'));
});

test('39. inside the finish window the card says the line is over', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  // 60-minute session started 2 min ago, with a 59-minute finish window -- i.e. already inside it.
  await lineShowing(admin, lineId, hhmmFromNow(-2), {
    sessionDuration: '60', finishWindow: '59', autoReschedule: 'off',
  });

  await expect(count(admin)).toHaveText("This line's time is over");
  await expect(count(admin)).toHaveClass(cls('lounge-text'));
  await expect(timer(admin)).toHaveClass(cls('finish-window'));
  await expect(timer(admin)).toHaveClass(cls('active'));
});

test('40. an expired line with auto-reschedule off reads 00:00 and has its time cleared', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  // Session of 10 min that started 40 min ago. autoReschedule off, so it must NOT advance.
  await lineShowing(admin, lineId, hhmmFromNow(-40), {
    sessionDuration: '10', finishWindow: '5', autoReschedule: 'off',
  });

  await expect(count(admin)).toHaveText('00:00');
  await expect(timer(admin)).not.toHaveClass(cls('active'));
  await expect(timer(admin)).not.toHaveClass(cls('finish-window'));

  // With auto-reschedule off, an expired line has its stored time CLEARED rather than advanced.
  // That is the contract: the line must be restarted by hand, not silently moved.
  await waitFor(() => oracle.lines(), (ls) => (ls.find((l) => l.id === lineId)?.time ?? '') === '', 10_000);
  expect((await oracle.lines()).find((l) => l.id === lineId)!.time).toBe('');
});

test('41. an unscheduled line shows no scheduled time, and carries neither state class', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  await lineShowing(admin, lineId, '');

  // Characterises a real inconsistency rather than asserting the tidy answer: tickOneLine()
  // RETURNS 'inactive' for an unscheduled line, but from an early return at `if (!startT)` that
  // sits above the classList.toggle at the end of the function -- so the class is never applied.
  // An unscheduled card therefore renders with plain `class="timer"` while a scheduled-but-not-
  // started card does get `inactive`, and the two look different for no stated reason. Worth
  // resolving during the restyle; pinned here so the current behaviour is at least known.
  await expect(timer(admin)).not.toHaveClass(cls('active'));
  await expect(timer(admin)).not.toHaveClass(cls('inactive'));
  await expect(count(admin).locator('.scheduled-time')).toHaveCount(0);
});

test('42. the people panel shows the seat count and the empty message', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);
  await waitFor(() => oracle.read('config/maxPeoplePerLine'), (v) => v === '10', 10_000);

  await expect(panel(admin).locator('.title')).toHaveText('People for next Line');
  await expect(panel(admin).locator('.seats-info')).toContainText('0/10 seats');
  await expect(panel(admin).locator('.empty-message')).toHaveText('No one here yet');

  await admin.addPersonToLine(0, 'Ann');
  await waitFor(() => oracle.allPersonNames(), (n) => n.includes('Ann'), 10_000);

  await expect(panel(admin).locator('.seats-info')).toContainText('1/10 seats');
  await expect(panel(admin).locator('.empty-message')).toHaveCount(0);
  await expect(panel(admin).locator('.person-entry')).toHaveCount(1);
  await expect(panel(admin).locator('.person-entry .person-order')).toHaveText('1.');
});

test('43. timer cards keep their configured order', async ({ browser }) => {
  // The cards are ordered by an inline style="order: N" on .timer-container, and the tests index
  // .line-config by position. If a restyle drops that inline style the cards reflow into DOM
  // order, which is a different thing that happens to look right most of the time.
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 3);
  await expect(admin.page.locator('#timers-container .timer-container')).toHaveCount(3);

  const orders = await admin.page
    .locator('#timers-container .timer-container')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.order));

  expect(orders).toEqual(['0', '1', '2']);
});
