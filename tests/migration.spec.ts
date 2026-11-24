// Characterisation test for the legacy -> keyed data migration.
//
// This is the highest-risk path in the app with the least coverage: a one-shot whole-tree set()
// that runs inside the Firebase snapshot handler. If it ever fired twice, or fired for a viewer,
// it would wipe concurrent edits. Nothing seeded a legacy tree, so none of it was exercised.
//
// It matters for the restyle only indirectly -- but it is cheap, and the template dedupe two
// stages from now runs inside the same snapshot handler.
import { test, expect } from '@playwright/test';
import { Actor } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';

test.beforeEach(async () => { await oracle.clearAll(); });

let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });

function track(a: Actor): Actor { actors.push(a); return a; }

test('57. a legacy array tree is migrated to keyed form without losing anyone', async ({ browser }) => {
  await oracle.seedMinimal();
  // The old shape: lines as a JSON array, people as an array inside each line. Firebase coerces
  // numeric-keyed objects back into arrays, which is the footgun isLegacyShape() exists to catch.
  await oracle.putValue('config/lines', [
    { name: 'Line 1', time: '', order: 0, people: [{ name: 'Ann' }, { name: 'Bob' }] },
    { name: 'Line 2', time: '', order: 1, people: [{ name: 'Cat' }] },
  ]);

  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));

  const lines = await waitFor(
    () => oracle.lines(),
    (ls) => ls.length === 2 && ls.every((l) => !/^\d+$/.test(l.id)),
    20_000,
  );

  // Numeric keys regenerated, so two clients adding a line can no longer collide on "2".
  expect(lines).toHaveLength(2);
  for (const l of lines) expect(l.id).not.toMatch(/^\d+$/);

  // Nobody lost in the move.
  expect((await oracle.allPersonNames()).slice().sort()).toEqual(['Ann', 'Bob', 'Cat']);
  expect(lines.map((l) => l.name).slice().sort()).toEqual(['Line 1', 'Line 2']);

  // And the screen agrees with the database.
  await expect(admin.page.locator('#timers-container .timer')).toHaveCount(2);
  await expect(admin.page.locator('#timers-container .person-entry')).toHaveCount(3);
});

test('58. the migration runs once and does not re-fire on later snapshots', async ({ browser }) => {
  await oracle.seedMinimal();
  await oracle.putValue('config/lines', [
    { name: 'Line 1', time: '', order: 0, people: [{ name: 'Ann' }] },
  ]);

  const admin = track(await Actor.create(browser, { label: 'admin', role: 'admin' }));
  const migrated = await waitFor(
    () => oracle.lines(),
    (ls) => ls.length === 1 && !/^\d+$/.test(ls[0].id),
    20_000,
  );
  const keyAfterMigration = migrated[0].id;

  // Provoke several more snapshots. A migration that re-fired would rewrite the whole tree and
  // regenerate the key -- and would clobber whatever else had been written in between.
  await admin.addPersonToLine(0, 'Bob');
  await waitFor(() => oracle.allPersonNames(), (n) => n.includes('Bob'), 10_000);
  await oracle.patchConfig({ sessionDuration: '45' });
  await admin.page.waitForTimeout(1500);

  const after = await oracle.lines();
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(keyAfterMigration);
  expect((await oracle.allPersonNames()).slice().sort()).toEqual(['Ann', 'Bob']);
});

test('59. a viewer never migrates the tree', async ({ browser }) => {
  // migrateToKeyed() is guarded against viewers. If that guard broke, a viewer joining mid-event
  // would rewrite the whole tree with a set() and clobber concurrent admin edits.
  await oracle.seedMinimal();
  await oracle.putValue('config/lines', [
    { name: 'Line 1', time: '', order: 0, people: [{ name: 'Ann' }] },
  ]);

  const viewer = track(await Actor.create(browser, { label: 'viewer', role: 'viewer' }));
  await expect(viewer.page.locator('#timers-container .timer')).toHaveCount(1);

  // Give the snapshot handler ample opportunity to misbehave.
  await viewer.page.waitForTimeout(2500);

  const raw = await oracle.read('config/lines');
  // Still the legacy array shape: untouched by the viewer.
  expect(Array.isArray(raw)).toBe(true);
  expect(await oracle.allPersonNames()).toEqual(['Ann']);
});
