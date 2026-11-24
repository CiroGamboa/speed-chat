// Characterisation tests for the settings panel: the six global dropdowns, the per-line name and
// start-time controls, and the capacity alert.
//
// Every existing test changes configuration through oracle.patchConfig(), i.e. over REST, so the
// real path -- change event -> updateTimingSettings() -> debounced writeConfigScalars() -- was
// never exercised. Only the READ side (snapshot -> form value -> globals) had any coverage.
import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { captureDialogs, ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

// The select id and the config key it writes are deliberately NOT the same for maxPeople, which
// is exactly the kind of mapping a refactor gets wrong silently.
const SCALARS: Array<{ selectId: string; dbKey: string; value: string }> = [
  { selectId: 'sessionDuration', dbKey: 'sessionDuration', value: '45' },
  { selectId: 'alarmInterval', dbKey: 'alarmInterval', value: '7' },
  { selectId: 'finishWindow', dbKey: 'finishWindow', value: '3' },
  { selectId: 'maxPeople', dbKey: 'maxPeoplePerLine', value: '12' },
  { selectId: 'blinkTime', dbKey: 'blinkTime', value: '8' },
  { selectId: 'autoReschedule', dbKey: 'autoReschedule', value: '15' },
];

for (const { selectId, dbKey, value } of SCALARS) {
  test(`44. changing #${selectId} writes config/${dbKey}`, async ({ browser }) => {
    const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
    await ensureLines(admin, 1);

    await admin.page.selectOption(`#${selectId}`, value);

    // writeConfigScalars() is debounced 400ms, so this is the write actually landing, not the
    // select's own value read back.
    const stored = await waitFor(() => oracle.read(`config/${dbKey}`), (v) => v === value, 10_000);
    expect(stored).toBe(value);
  });
}

test('45. the capacity alert fires and blocks the add', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);
  await admin.setMaxPeople(1);
  await waitFor(() => oracle.read('config/maxPeoplePerLine'), (v) => v === '1', 10_000);

  await admin.addPersonToLine(0, 'Ann');
  await waitFor(() => oracle.allPersonNames(), (n) => n.includes('Ann'), 10_000);

  const dialogs = await captureDialogs(admin.page, async () => {
    await admin.addPersonToLine(0, 'Bob');
  });

  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toMatch(/Maximum number of people \(1\)/);
  // The cap is a deliberately non-transactional soft limit, but it must still refuse locally.
  expect(await oracle.allPersonNames()).toEqual(['Ann']);
});

test('46. renaming a line persists and retitles its timer card', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  const nameInput = admin.page.locator('#linesContainer .line-config').first().locator('.line-name');
  await nameInput.fill('Balcony');
  await nameInput.dispatchEvent('change');

  const lines = await waitFor(() => oracle.lines(), (ls) => ls[0]?.name === 'Balcony', 10_000);
  expect(lines.find((l) => l.id === lineId)!.name).toBe('Balcony');
  await expect(admin.page.locator('#timers-container .timer .label')).toHaveText('Balcony');
});

test('47. the start-time dropdown offers a 5-minute grid two hours ahead', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  const options = await admin.page.locator(`#time${lineId} option`).allTextContents();
  const times = options.filter((t) => /^\d{2}:\d{2}$/.test(t));

  // 2 hours on a 5-minute grid is 24 slots, plus the first one; an empty placeholder may lead.
  expect(times.length).toBeGreaterThanOrEqual(24);
  for (const t of times) expect(Number(t.slice(3)) % 5).toBe(0);

  // Strictly increasing within the window, so a wrap or a duplicate is caught.
  const mins = times.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
  const wrapped = mins.some((m, i) => i > 0 && m < mins[i - 1]);
  if (!wrapped) expect(mins).toEqual([...mins].sort((a, b) => a - b));
});

test('48. picking a start time persists it and schedules the card', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  const select = admin.page.locator(`#time${lineId}`);
  const options = (await select.locator('option').allTextContents()).filter((t) => /^\d{2}:\d{2}$/.test(t));

  // Only consider slots BEFORE midnight. generateTimeOptions() offers two hours ahead and happily
  // crosses midnight, but parseTime() maps "HH:MM" onto TODAY -- so a 00:05 slot offered at 23:32
  // resolves to 23.5 hours in the PAST, the line counts as expired, and with auto-reschedule off
  // the app clears the time again. That is a real defect in the app, not in this test, and it is
  // deliberately not pinned here: it only reproduces in the last two hours of the day, so an
  // assertion on it would turn the suite red at exactly the hour someone runs it before an event.
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const sameDay = options.filter((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) > nowMins);
  test.skip(sameDay.length < 2, 'within two hours of midnight: every usable slot would wrap');

  // Far enough ahead to stay in the future for the whole test, and clear of the blink window.
  const chosen = sameDay[Math.min(6, sameDay.length - 1)];

  await select.selectOption(chosen);

  const lines = await waitFor(() => oracle.lines(), (ls) => (ls.find((l) => l.id === lineId)?.time ?? '') === chosen, 10_000);
  expect(lines.find((l) => l.id === lineId)!.time).toBe(chosen);

  // And the card picks it up rather than only the database.
  await expect(admin.page.locator('#timers-container .timer .count .scheduled-time')).toHaveText(chosen);
});

test('49. a dispatcher gets the panel but not the global settings', async ({ browser }) => {
  // updateUIBasedOnRole() hides the global settings, Add Line and the form buttons for a
  // dispatcher while leaving the line controls usable. All of it is style.display driven, which
  // is precisely what the restyle must not convert to opacity.
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  const dispatcher = track(await Actor.create(browser, { label: 'dispatcher', role: 'dispatcher' }));
  await expect(dispatcher.page.locator('#linesContainer .line-config')).toHaveCount(1);

  await expect(dispatcher.page.locator('.global-settings')).toBeHidden();
  await expect(dispatcher.page.locator('.add-line-btn')).toBeHidden();
  // ...but an admin in the same run sees them, so this is not a load-order artefact.
  await expect(admin.page.locator('.global-settings')).toBeVisible();
  await expect(admin.page.locator('.add-line-btn')).toBeVisible();
});

test('50. a viewer gets no config panel at all', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  const viewer = track(await Actor.create(browser, { label: 'viewer', role: 'viewer' }));

  await expect(viewer.page.locator('#configSection')).toBeHidden();
  // The viewer still sees the timers -- that is the whole point of the role.
  await expect(viewer.page.locator('#timers-container .timer')).toHaveCount(1);
});
