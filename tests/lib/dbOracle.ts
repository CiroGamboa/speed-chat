// dbOracle: reads/writes the REAL Firebase Realtime Database over its public REST endpoint.
// This is the objective "source of truth" the tests assert against — independent of what any single
// browser's optimistic UI shows. Rules are public read/write, so no auth is needed.
//
// It is deliberately SHAPE-AGNOSTIC: it understands both the new keyed-object structure (fixed app)
// and the legacy array structure (unfixed app), so the same assertions work in before/after runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DB_BASE = 'https://chill-speed-chat-default-rtdb.firebaseio.com';
// Which top-level DB namespace the suite reads and writes.
//
// Read LAZILY, on every call, and never cached: `tests/global-setup.ts` assigns a per-run
// `test_<id>` namespace into process.env BEFORE the workers fork, and a module-level const would
// have been frozen to 'state' at import time (global-setup imports this module itself).
//
// The app mirrors this via its `?stateNs=` parameter (getStateNamespace(), index.html:1464), whose
// validation is /^[A-Za-z0-9_-]{1,64}$/ — so a namespace is a FLAT top-level key like
// `test_a1b2c3`, never a path. `database.rules.json` grants access to any key beginning `test_`.
export function stateNs(): string {
  return process.env.STATE_NS || 'state';
}

/** True when we are pointed at the live event data rather than a throwaway test namespace. */
export function isProdNs(): boolean {
  return stateNs() === 'state';
}

const API_KEY = 'AIzaSyDWcpXD5jJgq-7l8N6JRoaZu0FbZTy7jh4';

// Under the locked-down rules ('.write': 'auth != null'), REST writes need an auth token.
//
// The credential is CACHED ON DISK and reused, rather than signing up a fresh anonymous user on
// every run. Firebase rate-limits anonymous sign-up per IP, and a suite that mints new accounts
// freely will eventually exhaust it -- at which point global-setup cannot clear the namespace and
// the whole run dies at startup with an opaque 401 before a single test executes. Worse, a
// throttled sign-in also makes the app slower to become writable, which surfaces as unrelated
// timing failures (alarm test 18 was mis-diagnosed as flaky for exactly this reason).
//
// So: sign up at most once ever on this machine, then refresh that credential forever. An idToken
// lasts an hour; the refresh token does not expire, and exchanging it is NOT rate-limited the way
// sign-up is.
//
// The cache file holds a credential that can write to this database, so it is gitignored. It is an
// anonymous account with no more power than any visitor's -- under `.write: 'auth != null'`
// anyone who loads the page gets an equivalent one -- but it is still a credential, not a fixture.
const TOKEN_CACHE = fileURLToPath(new URL('../.auth-cache.json', import.meta.url));

interface CachedCredential {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

function readCache(): CachedCredential | null {
  try {
    const c = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'));
    return c && c.refreshToken ? c : null;
  } catch {
    return null;
  }
}

function writeCache(c: CachedCredential): void {
  try {
    writeFileSync(TOKEN_CACHE, JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch {
    /* a non-writable checkout just means we sign up again next time */
  }
}

function toCredential(j: any): CachedCredential | null {
  // signUp returns camelCase, the token endpoint returns snake_case.
  const idToken = j.idToken || j.id_token;
  const refreshToken = j.refreshToken || j.refresh_token;
  const expiresIn = Number(j.expiresIn || j.expires_in || 3600);
  if (!idToken || !refreshToken) return null;
  return { idToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

async function refreshCredential(refreshToken: string): Promise<CachedCredential | null> {
  try {
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!r.ok) return null;
    return toCredential(await r.json());
  } catch {
    return null;
  }
}

async function signUpAnonymously(): Promise<CachedCredential | null> {
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    if (!r.ok) return null;
    return toCredential(await r.json());
  } catch {
    return null;
  }
}

let _tokenPromise: Promise<string | null> | null = null;
async function authToken(): Promise<string | null> {
  if (!_tokenPromise) {
    _tokenPromise = (async () => {
      const cached = readCache();

      // Still valid, with a minute of headroom so it cannot expire mid-run.
      if (cached && cached.expiresAt > Date.now() + 60_000) return cached.idToken;

      if (cached) {
        const refreshed = await refreshCredential(cached.refreshToken);
        if (refreshed) { writeCache(refreshed); return refreshed.idToken; }
        // Refresh failing means the account is gone; fall through and make a new one.
      }

      const fresh = await signUpAnonymously();
      if (fresh) { writeCache(fresh); return fresh.idToken; }

      // Still works unauthenticated if the rules ever go back to public.
      return null;
    })();
  }
  return _tokenPromise;
}

async function url(path: string, needsAuth: boolean): Promise<string> {
  const p = path ? '/' + path.replace(/^\/+/, '') : '';
  let u = `${DB_BASE}/${stateNs()}${p}.json`;
  if (needsAuth) {
    const t = await authToken();
    if (t) u += `?auth=${t}`;
  }
  return u;
}

async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const isWrite = method !== 'GET';
  const res = await fetch(await url(path, isWrite), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const oracle = {
  async read(path = ''): Promise<any> {
    return rest('GET', path);
  },
  async clearAll(): Promise<void> {
    await rest('DELETE', '');
  },
  // Seed a minimal VALID tree (satisfies the .validate rule) so viewer-first scenarios and the
  // legacy app both have a base. Config defaults can be overridden.
  async seedMinimal(config: Record<string, unknown> = {}): Promise<void> {
    await rest('PUT', '', {
      timestamp: Date.now(),
      config: Object.assign(
        {
          sessionDuration: '30',
          alarmInterval: '5',
          maxPeoplePerLine: '10',
          blinkBeforeStart: false,
          blinkTime: '5',
          finishWindow: '5',
          autoReschedule: 'off',
        },
        config,
      ),
    });
  },
  async patchConfig(fields: Record<string, unknown>): Promise<void> {
    await rest('PATCH', 'config', fields);
  },
  async putValue(path: string, value: unknown): Promise<void> {
    await rest('PUT', path, value);
  },
  // Set a line's start time to the current HH:MM so it is "active now" (for alarm tests).
  async makeLineActiveNow(lineId: string): Promise<string> {
    const d = new Date();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    await rest('PUT', `config/lines/${lineId}/time`, hhmm);
    return hhmm;
  },

  // ---- shape-agnostic readers ----
  // Returns an array of { id, name } for a given collection object/array.
  // NOT ORDERED. This returns Firebase's own key order (lexicographic over the client-generated
  // UUIDs), which has nothing to do with what the app displays: the app sorts people and queue
  // members by `ts` then key (entriesToArray) and lines by `order`. The two coincide often enough
  // that an order-sensitive assertion through the oracle passes most runs and fails occasionally.
  //
  // Assert SETS against the oracle and ORDER against the UI -- display order is what a restyle
  // can break, and the DOM is where it is observable.
  entries(obj: any): Array<{ id: string; name: string }> {
    if (!obj) return [];
    if (Array.isArray(obj)) {
      return obj.filter(Boolean).map((p: any, i: number) => ({ id: String(p?.id ?? i), name: p?.name ?? '' }));
    }
    return Object.entries(obj).map(([k, v]: [string, any]) => ({ id: k, name: v?.name ?? '' }));
  },
  // All lines as { id, name, people[], waitQueue[] } from either shape.
  async lines(): Promise<Array<{ id: string; name: string; people: any[]; waitQueue: any[]; time?: string }>> {
    const cfg = (await this.read('config')) || {};
    const raw = cfg.lines;
    if (!raw) return [];
    const list = Array.isArray(raw)
      ? raw.filter(Boolean).map((l: any, i: number) => ({ key: String(l?.id ?? i), l }))
      : Object.entries(raw).map(([key, l]: [string, any]) => ({ key, l }));
    return list.map(({ key, l }) => ({
      id: key,
      name: l?.name ?? '',
      time: l?.time ?? '',
      people: this.entries(l?.people),
      waitQueue: this.entries(l?.waitQueue),
    }));
  },
  async generalQueue(): Promise<Array<{ id: string; name: string }>> {
    const cfg = (await this.read('config')) || {};
    return this.entries(cfg.generalWaitQueue);
  },
  // Every person name across all lines (for lost-write assertions).
  async allPersonNames(): Promise<string[]> {
    const lines = await this.lines();
    const names: string[] = [];
    for (const l of lines) for (const p of l.people) names.push(p.name);
    return names;
  },
};

// Poll until predicate(value) is true or timeout. Returns the last value.
export async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 15000, intervalMs = 300): Promise<T> {
  const start = Date.now();
  let last = await fn();
  while (!predicate(last)) {
    if (Date.now() - start > timeoutMs) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}
