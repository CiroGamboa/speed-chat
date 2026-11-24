import type { Dialog, Page } from '@playwright/test';
import { Actor } from './actor';
import { oracle, waitFor } from './dbOracle';

// Run `fn` with a dialog handler attached and return every confirm()/alert() message it raised.
//
// Playwright AUTO-DISMISSES dialogs when nothing is listening, so without this a confirm()-gated
// delete silently returns false and the delete never happens -- the test then asserts on a no-op
// and passes for the wrong reason. Registering the handler scoped to one action, rather than
// globally on the Actor, keeps the existing specs' behaviour unchanged.
//
// Returning ALL messages (not just the first) is what makes "exactly one confirm" assertable,
// which is how the double-bound reset button is pinned.
export async function captureDialogs(
  page: Page,
  fn: () => Promise<void>,
  opts: { accept?: boolean; settleMs?: number } = {},
): Promise<string[]> {
  const { accept = true, settleMs = 800 } = opts;
  const seen: string[] = [];
  const handler = async (d: Dialog) => {
    seen.push(d.message());
    await (accept ? d.accept() : d.dismiss()).catch(() => {});
  };
  page.on('dialog', handler);
  try {
    await fn();
    // Give any FURTHER dialog time to arrive -- a second one is the defect we are looking for.
    await page.waitForTimeout(settleMs);
  } finally {
    page.off('dialog', handler);
  }
  return seen;
}

// Wait until the app has seeded a valid /state (timestamp + config present).
export async function waitSeeded(timeoutMs = 15000): Promise<void> {
  await waitFor(() => oracle.read(''), (s) => !!(s && s.timestamp && s.config), timeoutMs);
}

// Ensure exactly `n` lines exist (created by an admin through the real UI). Returns their ids.
export async function ensureLines(admin: Actor, n: number): Promise<string[]> {
  await waitSeeded();
  let have = (await oracle.lines()).length;
  while (have < n) {
    await admin.addLine();
    have = (await waitFor(() => oracle.lines(), (ls) => ls.length > have, 10000)).length;
  }
  const lines = await oracle.lines();
  return lines.map((l) => l.id);
}
