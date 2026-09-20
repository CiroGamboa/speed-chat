import { test, expect } from '@playwright/test';
import { Actor, concurrently } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });
let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });
function track(a: Actor): Actor { actors.push(a); return a; }

test('5. an admin who goes offline and reconnects loses no writes (and neither do the others)', async ({ browser }) => {
  const a1 = track(await Actor.create(browser, { label: 'admin1', role: 'admin' }));
  const a2 = track(await Actor.create(browser, { label: 'admin2', role: 'admin' }));

  await ensureLines(a1, 1);
  await oracle.patchConfig({ maxPeoplePerLine: '100' });

  // admin1 drops offline and keeps logging (writes are cached locally by Firebase).
  await a1.goOffline();
  await a1.rapidAddToLine(0, ['OFF-1', 'OFF-2', 'OFF-3']);

  // Meanwhile admin2 (online) keeps logging.
  await a2.rapidAddToLine(0, ['ON-1', 'ON-2', 'ON-3']);

  // Before reconnect the server should already have admin2's writes...
  await waitFor(() => oracle.allPersonNames(), (n) => n.filter((x) => x.startsWith('ON-')).length === 3, 15000);

  // admin1 reconnects -> its cached writes flush and MERGE with admin2's (no clobber).
  await a1.goOnline();

  const names = await waitFor(() => oracle.allPersonNames(), (n) => n.length >= 6, 20000);
  expect(names.length).toBe(6);
  expect(names.sort()).toEqual(['OFF-1', 'OFF-2', 'OFF-3', 'ON-1', 'ON-2', 'ON-3']);
});

test('6. a high-latency actor still converges to the same final state', async ({ browser }) => {
  const slow = track(await Actor.create(browser, { label: 'slow', role: 'admin' }));
  const fast = track(await Actor.create(browser, { label: 'fast', role: 'admin' }));

  await ensureLines(slow, 1);
  await oracle.patchConfig({ maxPeoplePerLine: '100' });
  await slow.setNetworkProfile('slow-3g');

  await concurrently([
    () => slow.rapidAddToLine(0, ['S-1', 'S-2', 'S-3', 'S-4', 'S-5']),
    () => fast.rapidAddToLine(0, ['F-1', 'F-2', 'F-3', 'F-4', 'F-5']),
  ]);

  const names = await waitFor(() => oracle.allPersonNames(), (n) => n.length >= 10, 30000);
  expect(names.length).toBe(10);

  // The slow client's own screen eventually catches up to all 10.
  await slow.setNetworkProfile('good');
  await expect.poll(() => slow.visiblePeopleCount(), { timeout: 20000 }).toBe(10);
});
