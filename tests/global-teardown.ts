// Runs once after the suite, deleting the throwaway namespace this run created so nothing lingers.
// When the run was explicitly pointed at prod, this leaves /state clean for the next real event.
import { oracle, stateNs, isProdNs } from './lib/dbOracle';

export default async function globalTeardown() {
  try {
    await oracle.clearAll();
    console.log(`\n[global-teardown] /${stateNs()} cleared${isProdNs() ? ' (prod)' : ''}.\n`);
  } catch (e) {
    console.warn(`[global-teardown] could not clear /${stateNs()}:`, e);
  }
}
