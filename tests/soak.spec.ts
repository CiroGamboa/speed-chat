import { test, expect } from '@playwright/test';
import { Actor, concurrently } from './lib/actor';
import { oracle, waitFor } from './lib/dbOracle';
import { ensureLines } from './lib/scenario';

test.beforeEach(async () => { await oracle.clearAll(); });
let actors: Actor[] = [];
test.afterEach(async () => { await Promise.all(actors.map((a) => a.close())); actors = []; });
function track(a: Actor): Actor { actors.push(a); return a; }

function rnd(n: number) { return Math.floor(Math.random() * n); }

test('10. chaos soak: 4 admins + random offline flaps converge with zero lost writes', async ({ browser }) => {
  test.setTimeout(180_000);

  const admins = [
    track(await Actor.create(browser, { label: 'A', role: 'admin' })),
    track(await Actor.create(browser, { label: 'B', role: 'admin' })),
    track(await Actor.create(browser, { label: 'C', role: 'admin' })),
    track(await Actor.create(browser, { label: 'D', role: 'admin' })),
  ];
  const viewer = track(await Actor.create(browser, { label: 'viewer', role: 'viewer' }));

  await ensureLines(admins[0], 3);
  await oracle.patchConfig({ maxPeoplePerLine: '500' }); // never hit cap during the soak

  const PER_ADMIN = 15;
  const expectedTotal = admins.length * PER_ADMIN;

  const routine = async (a: Actor) => {
    for (let i = 0; i < PER_ADMIN; i++) {
      // Occasionally simulate a connectivity blip mid-event.
      if (i > 0 && i % 5 === 0) {
        await a.goOffline();
        await a.addPersonToLine(rnd(3), `${a.label}-${i}`); // queued locally while offline
        await a.page.waitForTimeout(1200 + rnd(1500));
        await a.goOnline();
        continue; // that add counts as this iteration
      }
      await a.addPersonToLine(rnd(3), `${a.label}-${i}`);
      await a.page.waitForTimeout(150 + rnd(400));
    }
    await a.goOnline().catch(() => {});
  };

  await concurrently(admins.map((a) => () => routine(a)));

  // After the dust settles, the DB must contain every uniquely-named person exactly once.
  const names = await waitFor(() => oracle.allPersonNames(), (n) => n.length >= expectedTotal, 40000);
  expect(names.length).toBe(expectedTotal);
  expect(new Set(names).size).toBe(expectedTotal);
  for (const a of admins) for (let i = 0; i < PER_ADMIN; i++) expect(names).toContain(`${a.label}-${i}`);

  // Every open client — including the passive viewer — converges to the same total on screen.
  for (const a of [...admins, viewer]) {
    await expect.poll(() => a.visiblePeopleCount(), { timeout: 25000 }).toBe(expectedTotal);
  }

  // No client threw a genuine APP error during the chaos (offline WebSocket noise is expected).
  for (const a of actors) expect(a.appErrors(), `${a.label}: ${a.appErrors().join(' | ')}`).toEqual([]);
});
