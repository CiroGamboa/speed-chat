// Characterisation tests for "Reset All Settings" -- the most destructive control in the app, and
// one with no automated coverage at all.
//
// Note the two buttons that share the .reset-btn class: "Reset All Settings" and "Download alarm
// diagnostics" (index.html:1563-1566). The class is reused purely for styling, and
// document.querySelector('.reset-btn') at index.html:3681 therefore resolves BY DOM ORDER. Test 35
// pins that, because swapping those two buttons would silently attach resetApplication() to the
// diagnostics button.
import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { captureDialogs, ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

const resetButton = (a: Actor) => a.page.locator('.reset-btn', { hasText: 'Reset All Settings' });

test('32. Reset All Settings asks exactly once', async ({ browser }) => {
  // Regression test for a double-binding: the button carried BOTH an inline
  // onclick="resetApplication()" and an addEventListener calling the same function, so one click
  // raised two identical confirms. An operator who meant to cancel had to say no twice, and
  // no-then-yes still wiped the event. The listener was removed; the inline attribute remains.
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  // Dismissed, so this counts the prompts without actually resetting anything.
  const dialogs = await captureDialogs(admin.page, async () => { await resetButton(admin).click(); }, {
    accept: false,
  });

  expect(dialogs).toHaveLength(1);
});

test('33. dismissing the reset confirm changes nothing', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);
  await admin.addPersonToLine(0, 'Ann');
  await waitFor(() => oracle.allPersonNames(), (n) => n.includes('Ann'), 10_000);

  const dialogs = await captureDialogs(admin.page, async () => { await resetButton(admin).click(); }, {
    accept: false,
  });

  // Every prompt raised was declined, whatever their number, so nothing may have changed.
  expect(dialogs.length).toBeGreaterThanOrEqual(1);
  expect(dialogs[0]).toMatch(/reset all settings/i);
  const lines = await oracle.lines();
  expect(lines.map((l) => l.id)).toContain(lineId);
  expect(await oracle.allPersonNames()).toContain('Ann');
});

test('34. accepting the reset clears the lines, the people and the timer cards', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 2);
  await admin.addPersonToLine(0, 'Ann');
  await waitFor(() => oracle.allPersonNames(), (n) => n.includes('Ann'), 10_000);

  await captureDialogs(admin.page, async () => { await resetButton(admin).click(); }, { accept: true });

  await waitFor(() => oracle.lines(), (ls) => ls.length === 0, 15_000);
  expect(await oracle.lines()).toHaveLength(0);
  expect(await oracle.allPersonNames()).toHaveLength(0);

  await expect(admin.page.locator('#linesContainer .line-config')).toHaveCount(0);
  await expect(admin.page.locator('#timers-container .timer')).toHaveCount(0);
});

test('35. the diagnostics button shares the reset-btn class but must never reset', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  const diagnostics = admin.page.locator('.reset-btn', { hasText: 'Download alarm diagnostics' });
  await expect(diagnostics).toHaveCount(1);

  const dialogs = await captureDialogs(admin.page, async () => {
    await diagnostics.click();
  }, { accept: false });

  // No confirm at all, and the configuration is untouched. If reordering the two buttons ever
  // pointed querySelector('.reset-btn') at this one, this test is what catches it.
  expect(dialogs).toHaveLength(0);
  expect((await oracle.lines()).map((l) => l.id)).toContain(lineId);
});
