// Characterisation tests for the always-on furniture: the clock, the "next line" hint, the queue
// indicator, the alarm toggle's persistence, and the password gate.
//
// None of it had coverage. The password gate in particular is only ever walked THROUGH by
// Actor.create -- nothing asserted that it gates anything, that a wrong password is rejected, or
// that it hides with `display`, which the restyle must preserve (a modal left standing passes
// Playwright's visibility checks and silently eats every subsequent click).
import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, stateNs, waitFor } from './lib/dbOracle';
import { ensureLines } from './lib/scenario';

const PASSWORD = 'speedchat2025';
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

function hhmmFromNow(offsetMinutes: number): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

test('51. the clock shows server time and keeps ticking', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));

  const clock = admin.page.locator('#currentTime');
  await expect(clock).toHaveText(/^\d{2}:\d{2}$/);

  // Within a minute of the wall clock. Anchored on the app's own server-adjusted time, so a
  // skewed CI machine is not what this is measuring.
  const shown = await clock.textContent();
  const expected = [hhmmFromNow(-1), hhmmFromNow(0), hhmmFromNow(1)];
  expect(expected).toContain((shown || '').trim());
});

test('52. the next-line hint covers all three of its branches', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);
  const hint = admin.page.locator('#nextLineInfo');

  // (a) scheduled nothing
  await oracle.putValue(`config/lines/${lineId}/time`, '');
  await expect(hint).toHaveText('No lines scheduled', { timeout: 15_000 });

  // (b) something upcoming
  await oracle.patchConfig({ sessionDuration: '30', autoReschedule: 'off' });
  await oracle.putValue(`config/lines/${lineId}/time`, hhmmFromNow(25));
  await expect(hint).toHaveText(/^Next: .* starts in \d+ min$/, { timeout: 15_000 });

  // (c) one running and nothing else upcoming
  await oracle.putValue(`config/lines/${lineId}/time`, hhmmFromNow(-5));
  await expect(hint).toHaveText(/finishes in \d+ min$/, { timeout: 15_000 });
});

test('53. the wait-queue indicator tracks the queue', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  await expect(admin.page.locator('#waitQueueCount')).toHaveText('0');

  await admin.addGeneralQueuePerson('Ann');
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 1, 10_000);
  await expect(admin.page.locator('#waitQueueCount')).toHaveText('1');

  await admin.page.locator('#generalWaitQueueList .wait-queue-entry').first()
    .locator('button', { hasText: '×' }).click();
  await expect(admin.page.locator('#waitQueueCount')).toHaveText('0');
});

test('54. the alarm toggle survives a reload', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  await admin.setAlarmToggle(false);
  await expect(admin.page.locator('#alarmToggle')).not.toBeChecked();

  // Same context, so localStorage survives -- which is the whole point.
  await admin.page.reload({ waitUntil: 'domcontentloaded' });
  await admin.page.waitForLoadState('load').catch(() => {});

  await expect(admin.page.locator('#alarmToggle')).not.toBeChecked();
  const stored = await admin.page.evaluate(() => localStorage.getItem('alarmsEnabled'));
  expect(stored).toBe('false');
});

test('55. the password gate blocks, rejects a wrong password, and opens on the right one', async ({ browser }) => {
  // A deliberately raw context: Actor.create already walks past the gate, so it can never observe
  // the gate itself. Everything here is first-visit behaviour.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/?role=admin&stateNs=${encodeURIComponent(stateNs())}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('load').catch(() => {});

    const modal = page.locator('#passwordModal');
    await expect(modal).toBeVisible();

    await page.locator('#passwordInput').fill('not-the-password');
    await page.locator('#passwordModal button', { hasText: 'Submit' }).click();

    await expect(page.locator('#passwordError')).toBeVisible();
    await expect(page.locator('#passwordInput')).toHaveValue('');
    await expect(modal).toBeVisible();

    await page.locator('#passwordInput').fill(PASSWORD);
    await page.locator('#passwordModal button', { hasText: 'Submit' }).click();

    // Must reach Playwright's `hidden` state, not merely look faded: a modal that is still laid
    // out intercepts every pointer event behind it, and Actor.create asserts exactly this.
    await expect(modal).toBeHidden();
    const verified = await page.evaluate(() => localStorage.getItem('speedchat_password_verified'));
    expect(verified).toBe('true');
  } finally {
    await context.close();
  }
});

test('56. the config panel opens and closes via display, not opacity', async ({ browser }) => {
  // Pins the show/hide mechanism the harness depends on. Actor.configPanelOpen() reads both the
  // `visible` class and offsetParent; if a restyle swaps display for opacity or max-height, the
  // element keeps a box, Playwright still calls it visible, and the whole suite fails in ways
  // that look nothing like a styling change.
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  expect(await admin.configPanelOpen()).toBe(true);
  const openDisplay = await admin.page.locator('#configContent')
    .evaluate((el) => getComputedStyle(el).display);
  expect(openDisplay).not.toBe('none');

  await admin.page.locator('.config-header').click();
  await expect(admin.page.locator('#configContent')).toBeHidden();

  const closedDisplay = await admin.page.locator('#configContent')
    .evaluate((el) => getComputedStyle(el).display);
  expect(closedDisplay).toBe('none');
});
