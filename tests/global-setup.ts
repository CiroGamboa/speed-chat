// Runs once before the suite, in the main process, BEFORE any worker forks.
//
// By default the suite runs in a throwaway `test_<id>` namespace that cannot collide with the live
// event data at /state. The namespace is published via process.env so that both the workers
// (tests/lib/dbOracle.ts) and the browsers they drive (tests/lib/actor.ts, which appends
// `?stateNs=`) agree on it.
//
// Running against the real /state is still possible, but now has to be asked for explicitly.
import { oracle, stateNs, isProdNs } from './lib/dbOracle';

export default async function globalSetup() {
  if (!process.env.STATE_NS) {
    // ONE fixed namespace, matching the single `test_ci` key granted in database.rules.json.
    //
    // Not a per-run or per-machine id: that needs a wildcard rule, and a namespace orphaned by a
    // crashed run would be unreclaimable (reads are granted per key and the DB root is unreadable),
    // so every interruption would leak a key only the Firebase console could see. One fixed name is
    // simply re-cleared by the clearAll() below, and the suite runs single-worker against a shared
    // namespace anyway, so per-run isolation would buy nothing today.
    //
    // Satisfies the app's own validation, /^[A-Za-z0-9_-]{1,64}$/ (getStateNamespace).
    process.env.STATE_NS = 'test_ci';
  }

  // The frozen "unfixed" fixture is a snapshot of commit f407c20, which predates
  // getStateNamespace() entirely — it ignores ?stateNs= and talks to /state no matter what we
  // append to the URL. Left unchecked, the documented before/after workflow would write to the
  // LIVE event data while the oracle asserted against an isolated namespace: every assertion
  // fails for reasons that look nothing like the cause, and prod gets clobbered on the way.
  const usingUnfixedFixture = (process.env.APP_PAGE || '').includes('unfixed');
  if (usingUnfixedFixture && !isProdNs()) {
    throw new Error(
      '\n\nRefusing to run: APP_PAGE points at the frozen "unfixed" fixture, which predates\n' +
      '?stateNs= (commit f407c20) and will write to the REAL /state regardless of STATE_NS.\n' +
      `STATE_NS is currently "${stateNs()}", so the app and the oracle would disagree.\n\n` +
      'To run the before/after comparison, opt in explicitly and make sure NO live event is\n' +
      'in progress:  STATE_NS=state RUN_AGAINST_PROD=1 APP_PAGE=/index.unfixed.html\n',
    );
  }

  if (isProdNs() && !process.env.RUN_AGAINST_PROD) {
    throw new Error(
      '\n\nRefusing to run: STATE_NS is "state", the REAL live event data.\n' +
      'Leave STATE_NS unset to get an isolated test namespace, or set RUN_AGAINST_PROD=1\n' +
      'if you really mean to run against prod and NO live event is in progress.\n',
    );
  }

  console.log(`\n[global-setup] Namespace: /${stateNs()}${isProdNs() ? '  *** LIVE PROD DATA ***' : ' (isolated)'}`);
  await oracle.clearAll();
  console.log('[global-setup] Cleared; the app will self-seed on first admin load.\n');
}
