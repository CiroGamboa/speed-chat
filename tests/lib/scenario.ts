import { Actor } from './actor';
import { oracle, waitFor } from './dbOracle';

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
