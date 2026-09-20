// Runs once after the suite. Leaves /state clean so nothing lingers for the next real event.
import { oracle } from './lib/dbOracle';

export default async function globalTeardown() {
  try {
    await oracle.clearAll();
    console.log('\n[global-teardown] /state cleared.\n');
  } catch (e) {
    console.warn('[global-teardown] could not clear /state:', e);
  }
}
