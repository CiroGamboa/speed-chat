// Characterisation tests for the general wait queue: its list, the per-row "Move" dropdown, and
// bulk promote. The queue's whole reason for existing -- getting someone out of the lobby and onto
// a line -- had no automated coverage at all before this file.
//
// These exist to guard a restyle. renderGeneralWaitQueue() builds every row as an HTML string with
// inline style="" attributes, and the planned work moves those into CSS classes. One of them must
// NOT move: see the "click twice" test below.
import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { captureDialogs, ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

const rows = (a: Actor) => a.page.locator('#generalWaitQueueList .wait-queue-entry');
const moveButton = (a: Actor, rowIndex: number) =>
  rows(a).nth(rowIndex).locator('button', { hasText: 'Move' });

// Addressed through the ROW, never through an id taken from the oracle. The oracle reports
// Firebase's key order while the DOM renders in `ts` order, so pairing "row N" with
// "oracle.generalQueue()[N]" is a coin flip that passes about half the time.
const dropdown = (a: Actor, rowIndex: number) =>
  rows(a).nth(rowIndex).locator('[id^="moveDropdown"]');

const personIdOfRow = (a: Actor, rowIndex: number) =>
  dropdown(a, rowIndex).getAttribute('id').then((id) => (id || '').replace('moveDropdown', ''));

test('19. the queue renders one ordered row per person, and both counters agree', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  for (const name of ['Ann', 'Bob', 'Cat']) await admin.addGeneralQueuePerson(name);
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 3, 10_000);

  await expect(rows(admin)).toHaveCount(3);
  // Insertion order is stable across devices (entriesToArray sorts by ts then key), so the
  // displayed order is part of the contract, not an accident of object iteration.
  await expect(rows(admin)).toContainText(['Ann', 'Bob', 'Cat']);
  await expect(rows(admin).locator('.person-order')).toContainText(['1.', '2.', '3.']);

  // Two separate counters are derived from the same list and must not drift apart.
  await expect(admin.page.locator('#generalWaitQueueCount')).toHaveText('3');
  await expect(admin.page.locator('#waitQueueCount')).toHaveText('3');
});

test('20. the Move dropdown opens on the FIRST click, lists every line, and promotes', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const lineIds = await ensureLines(admin, 2);
  const lineNames = (await oracle.lines()).map((l) => l.name);

  await admin.addGeneralQueuePerson('Ann');
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 1, 10_000);
  await expect(rows(admin)).toHaveCount(1);

  // "On the first click" is the whole point. toggleMoveDropdown() reads dropdown.style.display,
  // which only ever sees the INLINE declaration. If the restyle moves `display:none` into a CSS
  // class, the first read returns '' , the ternary yields 'none', and the dropdown needs two
  // clicks to open. That is invisible to every other assertion in the suite.
  await moveButton(admin, 0).click();
  await expect(dropdown(admin, 0)).toBeVisible();
  // Compared as a SET: the oracle returns Firebase's key order (lexicographic over UUIDs), while
  // the dropdown renders lineConfigs in `order`. The two coincide often enough that an ordered
  // assertion here passes most runs and fails occasionally -- see the note in dbOracle.
  const dropdownNames = await dropdown(admin, 0).locator('button').allTextContents();
  expect(dropdownNames.slice().sort()).toEqual(lineNames.slice().sort());
  expect(dropdownNames).toHaveLength(2);

  // Promote to the SECOND line, so a bug that always picks the first is caught.
  await dropdown(admin, 0).locator('button', { hasText: lineNames[1] }).click();

  const lines = await waitFor(
    () => oracle.lines(),
    (ls) => ls.some((l) => l.people.some((p: any) => p.name === 'Ann')),
    10_000,
  );
  const target = lines.find((l) => l.id === lineIds[1])!;
  expect(target.people.map((p: any) => p.name)).toContain('Ann');
  expect(await oracle.generalQueue()).toHaveLength(0);
});

test('21. a click outside closes the dropdown', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);
  await admin.addGeneralQueuePerson('Ann');
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 1, 10_000);
  await expect(rows(admin)).toHaveCount(1);

  await moveButton(admin, 0).click();
  await expect(dropdown(admin, 0)).toBeVisible();

  await admin.page.mouse.click(5, 5);
  await expect(dropdown(admin, 0)).toBeHidden();
});

test('22. only one dropdown is open at a time', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);
  for (const name of ['Ann', 'Bob']) await admin.addGeneralQueuePerson(name);
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 2, 10_000);
  await expect(rows(admin)).toHaveCount(2);

  await moveButton(admin, 0).click();
  await expect(dropdown(admin, 0)).toBeVisible();

  // Invoked directly rather than clicked, because an open dropdown physically covers the Move
  // button of the row beneath it (position:absolute, z-index 1000, anchored to the row above) --
  // Playwright reports "subtree intercepts pointer events" and the click never lands. That overlap
  // is a real layout wart, recorded in test 22b below; here we are isolating the close-the-others
  // LOGIC in toggleMoveDropdown, which a restyle could break independently of the overlap.
  await admin.page.evaluate((id) => (window as any).toggleMoveDropdown(id), await personIdOfRow(admin, 1));

  await expect(dropdown(admin, 1)).toBeVisible();
  await expect(dropdown(admin, 0)).toBeHidden();
});

test('22b. an open dropdown covers the row beneath it (known wart, pinned so a restyle can fix it)', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);
  for (const name of ['Ann', 'Bob']) await admin.addGeneralQueuePerson(name);
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 2, 10_000);
  await expect(rows(admin)).toHaveCount(2);

  await moveButton(admin, 0).click();

  // Documents TODAY's behaviour: the second row's Move button is unreachable while the first
  // row's dropdown is open. If a restyle makes this click succeed, that is an improvement -- flip
  // this assertion rather than reverting the layout.
  const blocked = await moveButton(admin, 1)
    .click({ timeout: 3_000 })
    .then(() => false)
    .catch(() => true);

  expect(blocked).toBe(true);
});

test('23. bulk promote fills the line to capacity and leaves the rest queued', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);

  // Wait for the capacity change to reach the DATABASE, not just the select. The write is
  // debounced 400ms, and every snapshot re-reads MAX_PEOPLE_PER_LINE from the stored value
  // (index.html:2637) -- so a snapshot arriving inside that window silently reverts capacity to
  // the seeded default, which is 1 (see test 25). That reverted only Ann and looked like a bulk
  // promote bug.
  await admin.setMaxPeople(3);
  await waitFor(() => oracle.read('config/maxPeoplePerLine'), (v) => v === '3', 10_000);

  for (const name of ['Ann', 'Bob', 'Cat', 'Dan', 'Eve']) await admin.addGeneralQueuePerson(name);
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 5, 15_000);
  // bulkPromoteToLine reads the PAGE's generalWaitQueue array, not the database. Waiting only for
  // the DB to hold five promoted just one, because the snapshot had not landed in this tab yet.
  await expect(rows(admin)).toHaveCount(5);

  await admin.page.locator('#bulkPromoteButtons button').first().click();

  const lines = await waitFor(
    () => oracle.lines(),
    (ls) => (ls.find((l) => l.id === lineId)?.people.length ?? 0) === 3,
    10_000,
  );
  // Exactly capacity, taken from the FRONT of the queue. Compared as sets, because the oracle
  // reports Firebase's key order rather than the app's (people sort by ts, lines by `order`);
  // display order is asserted against the UI in test 19, which is where a restyle could break it.
  const promoted = lines.find((l) => l.id === lineId)!.people.map((p: any) => p.name);
  expect(promoted.slice().sort()).toEqual(['Ann', 'Bob', 'Cat']);
  const remaining = (await oracle.generalQueue()).map((p) => p.name);
  expect(remaining.slice().sort()).toEqual(['Dan', 'Eve']);
});

test('24. bulk promote onto a full line alerts and moves nobody', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);
  await admin.setMaxPeople(1);

  for (const name of ['Ann', 'Bob']) await admin.addGeneralQueuePerson(name);
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 2, 10_000);

  await admin.page.locator('#bulkPromoteButtons button').first().click();
  await waitFor(() => oracle.lines(), (ls) => (ls.find((l) => l.id === lineId)?.people.length ?? 0) === 1, 10_000);

  // Second attempt: the line is full, so this must be refused rather than silently over-filling.
  const dialogs = await captureDialogs(admin.page, async () => {
    await admin.page.locator('#bulkPromoteButtons button').first().click();
  });

  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toMatch(/already full/i);
  const after = await oracle.lines();
  expect(after.find((l) => l.id === lineId)!.people).toHaveLength(1);
  expect(await oracle.generalQueue()).toHaveLength(1);
});

// EXPECTED FAILURE until the one-word fix in Stage 2. Flip this to a normal test then.
//
// #maxPeople is the only one of the six config selects with no `selected` attribute on any option
// (sessionDuration, alarmInterval, finishWindow, blinkTime and autoReschedule all have one), so
// the browser falls back to its FIRST option -- value "1". currentScalars() reads that select
// straight off the DOM (index.html:2499), so a freshly seeded database gets
// maxPeoplePerLine: "1", and every line caps at a single person until an admin notices and
// changes the setting by hand. Adding a second person alerts "Maximum number of people (1)".
test('25. a freshly seeded database does not cap every line at one person', async ({ browser }) => {
  test.fail(); // must be INSIDE the test: at file scope it marks every test in the file
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  const seeded = await waitFor(
    () => oracle.read('config/maxPeoplePerLine'),
    (v) => v !== null && v !== undefined,
    10_000,
  );

  expect(Number(seeded)).toBeGreaterThan(1);
});
