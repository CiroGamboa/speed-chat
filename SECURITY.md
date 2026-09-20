# Security notes (Firebase Realtime Database)

> Status: **documented, not changed.** The current rules are intentionally left as-is for this pass.
> This file records the risk and a recommended lockdown for a future change.

## Current rules (public read/write)

```json
{
  "rules": {
    "state": {
      ".read": true,
      ".write": true,
      ".validate": "newData.hasChildren(['timestamp', 'config'])"
    }
  }
}
```

Anyone who knows the database URL can read or overwrite `/state`. That is acceptable only because the
data is low-value, ephemeral event scratch. Two things worth knowing:

1. **The `.validate` rule cascades.** A write anywhere under `/state` is rejected unless the resulting
   `/state` still has both `timestamp` and `config`. This is why the app seeds a minimal
   `{ timestamp, config }` (via a transaction) before any granular write — see `ensureSeeded()` in
   `index.html`. Keep that behaviour if you tighten the rules.
2. **Numeric keys are avoided on purpose.** Lines/people/queues use `crypto.randomUUID()` keys, never
   numeric ids, because Firebase coerces numeric-keyed objects back into arrays.

## Lockdown: ready to enable (2 Console steps)

Everything on the code side is done and deployed:

- The app signs in **anonymously** on load (`firebase.auth().signInAnonymously()` in `index.html`),
  backward-compatibly — under the current public rules it's simply not required, so nothing changed.
- `database.rules.json` in this repo contains the locked-down rules (writes require auth):

  ```json
  {
    "rules": {
      "state": {
        ".read": true,
        ".write": "auth != null",
        ".validate": "newData.hasChildren(['timestamp', 'config'])"
      }
    }
  }
  ```

- The test harness authenticates its REST writes when auth is available, so the suite works before
  and after lockdown.

**Why this can't be done from the dev environment:** the rules endpoint is admin-only (403 without a
secret), there is no Firebase CLI, and the available `gcloud` account does not have access to the
`chill-speed-chat` Firebase project. The two steps below must be done in the Firebase Console (on the
account that owns the project), or by authenticating the Firebase CLI as that owner.

### Step 1 — enable Anonymous Auth
Firebase Console → **Build → Authentication → Sign-in method → Anonymous → Enable**.
(Currently disabled — verified: `signInAnonymously` returns `CONFIGURATION_NOT_FOUND`.)

### Step 2 — publish the rules
Firebase Console → **Build → Realtime Database → Rules** → paste `database.rules.json` → **Publish**.
(Or with the Firebase CLI as the project owner: `firebase deploy --only database`.)

### Order & safety
Do Step 1 **before** Step 2. The app is already deployed with anonymous sign-in, so once both steps
are done, writes carry a token and keep working. Reads stay public (`.read: true`), so viewers are
never blocked.

### Verify
- App: open the live site, add a person, confirm it still saves (check the browser console for
  "Signed in anonymously").
- Unauthenticated writes are now blocked (should return 401):
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -X PUT \
    -d '{"x":1}' "https://chill-speed-chat-default-rtdb.firebaseio.com/state/probe.json"
  ```
- Re-run the suite (it self-authenticates): `RUN_AGAINST_PROD=1 npm test`.

### Rollback
Re-publish the original public rules (set `.write` back to `true`) in the Console; the app keeps
working either way.

> Note: anonymous auth only blocks drive-by *unauthenticated* writes — anyone can still anon-sign-in.
> For a low-value, ephemeral app that's a reasonable bar. For stronger control, gate on a real
> sign-in (Google) and restrict to known UIDs.
