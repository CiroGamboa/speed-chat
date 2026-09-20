import { test, expect } from '@playwright/test';
import { Actor, concurrently } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { ensureLines, waitSeeded } from './lib/scenario';

// Every test starts from a clean /state; the fixed app self-seeds on the first admin load.
test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

test('1. a logged person propagates to other sessions', async ({ browser }) => {
  const admin1 = track(await Actor.create(browser, { label: 'admin1', role: 'admin' }));
  const admin2 = track(await Actor.create(browser, { label: 'admin2', role: 'admin' }));
  const viewer = track(await Actor.create(browser, { label: 'viewer', role: 'viewer' }));

  await ensureLines(admin1, 1);
  await admin1.addPersonToLine(0, 'Alice');

  // Source of truth: the DB has exactly Alice.
  const names = await waitFor(() => oracle.allPersonNames(), (n) => n.includes('Alice'), 10000);
  expect(names).toContain('Alice');

  // And it propagated to the other admin and the viewer's screens.
  await expect(admin2.page.locator('#timers-container .person-entry')).toContainText(['Alice']);
  await expect(viewer.page.locator('#timers-container .person-entry')).toContainText(['Alice']);
});

test('2. concurrent logging on the SAME line loses nobody', async ({ browser }) => {
  const a1 = track(await Actor.create(browser, { label: 'admin1', role: 'admin' }));
  const a2 = track(await Actor.create(browser, { label: 'admin2', role: 'admin' }));
  const a3 = track(await Actor.create(browser, { label: 'admin3', role: 'admin' }));

  await ensureLines(a1, 1);
  await oracle.patchConfig({ maxPeoplePerLine: '100' }); // raise cap so all adds are valid
  await waitFor(() => oracle.read('config/maxPeoplePerLine'), (v) => v === '100', 8000);

  const per = 12;
  const mk = (who: string) => Array.from({ length: per }, (_, i) => `${who}-${i + 1}`);

  // All three admins hammer line 0 at the same time.
  await concurrently([
    () => a1.rapidAddToLine(0, mk('A1')),
    () => a2.rapidAddToLine(0, mk('A2')),
    () => a3.rapidAddToLine(0, mk('A3')),
  ]);

  const expected = per * 3; // 36
  const names = await waitFor(() => oracle.allPersonNames(), (n) => n.length >= expected, 25000);
  expect(names.length).toBe(expected);
  expect(new Set(names).size).toBe(expected); // all distinct, none clobbered
  for (const who of ['A1', 'A2', 'A3']) for (let i = 1; i <= per; i++) expect(names).toContain(`${who}-${i}`);
});

test('3. concurrent logging on DIFFERENT lines all persists', async ({ browser }) => {
  const a1 = track(await Actor.create(browser, { label: 'admin1', role: 'admin' }));
  const a2 = track(await Actor.create(browser, { label: 'admin2', role: 'admin' }));
  const a3 = track(await Actor.create(browser, { label: 'admin3', role: 'admin' }));

  await ensureLines(a1, 3);
  await oracle.patchConfig({ maxPeoplePerLine: '100' });

  const per = 10;
  const mk = (who: string) => Array.from({ length: per }, (_, i) => `${who}-${i + 1}`);
  await concurrently([
    () => a1.rapidAddToLine(0, mk('L0')),
    () => a2.rapidAddToLine(1, mk('L1')),
    () => a3.rapidAddToLine(2, mk('L2')),
  ]);

  const names = await waitFor(() => oracle.allPersonNames(), (n) => n.length >= per * 3, 25000);
  expect(names.length).toBe(per * 3);
  const lines = await oracle.lines();
  for (const l of lines) expect(l.people.length).toBe(per);
});

test('4. adding to a per-line wait queue does NOT wipe the general queue', async ({ browser }) => {
  const a1 = track(await Actor.create(browser, { label: 'admin1', role: 'admin' }));
  const a2 = track(await Actor.create(browser, { label: 'admin2', role: 'admin' }));

  const ids = await ensureLines(a1, 1);
  const lineId = ids[0];

  // admin1 fills the general queue.
  for (const n of ['G1', 'G2', 'G3', 'G4', 'G5']) await a1.addGeneralQueuePerson(n);
  await waitFor(() => oracle.generalQueue(), (q) => q.length === 5, 10000);

  // admin2 concurrently adds to the line's per-line wait queue AND to the line's people.
  await concurrently([
    () => a2.addToLineWaitQueueViaApp(lineId, 'W1'),
    () => a2.addToLineWaitQueueViaApp(lineId, 'W2'),
    () => a2.addPersonToLine(0, 'P1'),
  ]);

  // The general queue must be intact (this was the regression: whole-tree writes wiped it).
  const gq = await waitFor(() => oracle.generalQueue(), () => true, 4000);
  expect(gq.map((p) => p.name).sort()).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
  const lines = await oracle.lines();
  expect(lines[0].waitQueue.length).toBe(2);
});

test('9. two admins creating a line at the same instant produce two distinct lines', async ({ browser }) => {
  const a1 = track(await Actor.create(browser, { label: 'admin1', role: 'admin' }));
  const a2 = track(await Actor.create(browser, { label: 'admin2', role: 'admin' }));
  await waitSeeded();

  await concurrently([() => a1.addLine(), () => a2.addLine()]);

  const lines = await waitFor(() => oracle.lines(), (ls) => ls.length >= 2, 12000);
  expect(lines.length).toBe(2);
  const ids = new Set(lines.map((l) => l.id));
  expect(ids.size).toBe(2); // distinct keys, not merged/overwritten
});
