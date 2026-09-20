// Runs once before the suite. The app is stateless (/state is ephemeral event scratch), so we simply
// start from a clean slate. A guard prevents accidentally clearing data during a live event.
import { oracle } from './lib/dbOracle';

export default async function globalSetup() {
  if (!process.env.RUN_AGAINST_PROD) {
    throw new Error(
      '\n\nRefusing to run: these tests write to the REAL prod /state.\n' +
      'Set RUN_AGAINST_PROD=1 and make sure NO live event is in progress, then re-run.\n',
    );
  }
  console.log('\n[global-setup] Clearing /state for a clean test run (app is stateless).');
  await oracle.clearAll();
  console.log('[global-setup] Done. /state is empty; the app will self-seed on first admin load.\n');
}
