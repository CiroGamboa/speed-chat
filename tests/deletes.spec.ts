// Characterisation tests for every delete path. None of these had automated coverage, and all of
// them are either confirm()-gated or role-gated -- the two kinds of behaviour a restyle can break
// without anything visibly going wrong until someone at an event clicks the button.
//
// The confirm-gated ones assert BOTH branches. Dismissing matters at least as much as accepting:
// "Clear All" that deletes anyway when you say no is far worse than one that fails to delete.
import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { captureDialogs, ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

const configRows = (a: Actor) => a.page.locator('#linesContainer .line-config');
const peopleRows = (a: Actor, lineIndex = 0) =>
  configRows(a).nth(lineIndex).locator('.people-list .person-entry');
const queueRows = (a: Actor) => a.page.locator('#generalWaitQueueList .wait-queue-entry');

test('26. removing one person leaves the others alone', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const [lineId] = await ensureLines(admin, 1);
  await admin.setMaxPeople(5);
  await waitFor(() => oracle.read('config/maxPeoplePerLine'), (v) => v === '5', 10_000);

  for (const name of ['Ann', 'Bob', 'Cat']) await admin.addPersonToLine(0, name);
  await waitFor(() => oracle.allPersonNames(), (n) => n.length === 3, 10_000);
  await expect(peopleRows(admin)).toHaveCount(3);

  // Remove whoever is displayed SECOND, addressed through the DOM -- the oracle is unordered.
  const victim = (await peopleRows(admin).nth(1).innerText()).replace(/^\s*\d+\.\s*/, '').replace(/×/g, '').trim();
  await peopleRows(admin).nth(1).locator('button', { hasText: '×' }).click();

  const left = await waitFor(() => oracle.allPersonNames(), (n) => n.length === 2, 10_000);
  expect(left).toHaveLength(2);
  expect(left).not.toContain(victim);
  expect(left.slice().sort()).toEqual(['Ann', 'Bob', 'Cat'].filter((n) => n !== victim));
  // The line itself survives a person deletion.
  expect((await oracle.lines()).map((l) => l.id)).toContain(lineId);
});

test('27. Clear All on a line deletes nobody when the confirm is dismissed', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);
  await admin.setMaxPeople(5);
  await waitFor(() => oracle.read('config/maxPeoplePerLine'), (v) => v === '5', 10_000);

  for (const name of ['Ann', 'Bob']) await admin.addPersonToLine(0, name);
  await waitFor(() => oracle.allPersonNames(), (n) => n.length === 2, 10_000);

  const clearAll = configRows(admin).nth(0).locator('button', { hasText: 'Clear All' });

  const dismissed = await captureDialogs(admin.page, async () => { await clearAll.click(); }, { accept: false });
  expect(dismissed).toHaveLength(1);
  expect(dismissed[0]).toMatch(/clear all people/i);
  expect(await oracle.allPersonNames()).toHaveLength(2);

  const accepted = await captureDialogs(admin.page, async () => { await clearAll.click(); }, { accept: true });
  expect(accepted).toHaveLength(1);
  await waitFor(() => oracle.allPersonNames(), (n) => n.length === 0, 10_000);
  expect(await oracle.allPersonNames()).toHaveLength(0);
  await expect(configRows(admin).nth(0).locator('.empty-message')).toBeVisible();
});

test('28. removing one person from the general queue leaves the others alone', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  for (const name of ['Ann', 'Bob', 'Cat']) await admin.addGeneralQueuePerson(name);
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 3, 10_000);
  await expect(queueRows(admin)).toHaveCount(3);

  await queueRows(admin).nth(1).locator('button', { hasText: '×' }).click();

  const left = await waitFor(() => oracle.generalQueue(), (q) => q.length === 2, 10_000);
  expect(left.map((p) => p.name).slice().sort()).toEqual(['Ann', 'Cat']);
  await expect(admin.page.locator('#waitQueueCount')).toHaveText('2');
});

test('29. Clear All on the general queue honours both answers to the confirm', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  for (const name of ['Ann', 'Bob']) await admin.addGeneralQueuePerson(name);
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 2, 10_000);

  const clearAll = admin.page.locator('#clearGeneralWaitQueueBtn');

  const dismissed = await captureDialogs(admin.page, async () => { await clearAll.click(); }, { accept: false });
  expect(dismissed).toHaveLength(1);
  expect(await oracle.generalQueue()).toHaveLength(2);

  await captureDialogs(admin.page, async () => { await clearAll.click(); }, { accept: true });
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 0, 10_000);
  expect(await oracle.generalQueue()).toHaveLength(0);
  await expect(admin.page.locator('#waitQueueCount')).toHaveText('0');
});

test('30. removing a line deletes it and its timer card, and spares the other line', async ({ browser }) => {
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 2);
  await expect(configRows(admin)).toHaveCount(2);

  const survivingName = await configRows(admin).nth(1).locator('.line-name').inputValue();
  await configRows(admin).nth(0).locator('button', { hasText: 'Remove Line' }).click();

  const left = await waitFor(() => oracle.lines(), (ls) => ls.length === 1, 10_000);
  expect(left).toHaveLength(1);
  expect(left[0].name).toBe(survivingName);

  // The timer card must go too -- it is rendered from the same list, so a card left behind would
  // mean the two renderers had diverged.
  await expect(configRows(admin)).toHaveCount(1);
  await expect(admin.page.locator('#timers-container .timer')).toHaveCount(1);
});

test('31. a dispatcher is not offered Remove Line', async ({ browser }) => {
  // Guards the currentRole === 'admin' branch of the line-card template, which the planned
  // template dedupe touches. removeLineConfig() also refuses on the server side, but the point
  // here is that the control is not rendered at all.
  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  await ensureLines(admin, 1);

  const dispatcher = track(await Actor.create(browser, { label: 'dispatcher', role: 'dispatcher' }));
  await expect(configRows(dispatcher)).toHaveCount(1);

  await expect(configRows(dispatcher).locator('button', { hasText: 'Remove Line' })).toHaveCount(0);
  // ...while the admin in the same run does get it, so this is not just a rendering lag.
  await expect(configRows(admin).locator('button', { hasText: 'Remove Line' })).toHaveCount(1);
});
