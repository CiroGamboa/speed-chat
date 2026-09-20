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

## Recommended lockdown (future work)

If/when you want to restrict access, the lowest-friction option that keeps the current UX is a shared
secret checked in rules, or Firebase Anonymous Auth with a write restriction. Sketch:

```json
{
  "rules": {
    "state": {
      ".read": true,
      ".write": "auth != null",
      ".validate": "newData.hasChildren(['timestamp', 'config'])",
      "config": {
        "lines": {
          "$lineId": {
            "name": { ".validate": "newData.isString()" },
            "people": {
              "$pid": { "name": { ".validate": "newData.isString()" } }
            }
          }
        }
      }
    }
  }
}
```

Enabling `auth != null` requires the app to sign in (e.g. anonymous auth) on load. That is a small,
separate change and is **not** part of the sync/alarm fix.
