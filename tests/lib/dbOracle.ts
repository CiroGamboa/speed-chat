// dbOracle: reads/writes the REAL Firebase Realtime Database over its public REST endpoint.
// This is the objective "source of truth" the tests assert against — independent of what any single
// browser's optimistic UI shows. Rules are public read/write, so no auth is needed.
//
// It is deliberately SHAPE-AGNOSTIC: it understands both the new keyed-object structure (fixed app)
// and the legacy array structure (unfixed app), so the same assertions work in before/after runs.

export const DB_BASE = 'https://chill-speed-chat-default-rtdb.firebaseio.com';
// The app the tests drive uses the real /state path (per the chosen prod target). Override with
// STATE_NS if you ever want isolation (would require a matching security rule for that path).
export const STATE_NS = process.env.STATE_NS || 'state';

const API_KEY = 'AIzaSyDWcpXD5jJgq-7l8N6JRoaZu0FbZTy7jh4';

// Under the locked-down rules ('.write': 'auth != null'), REST writes need an auth token. We fetch a
// Firebase anonymous idToken lazily; if the Anonymous provider isn't enabled (current public rules),
// this fails and we fall back to unauthenticated writes — so the suite works before AND after lockdown.
let _tokenPromise: Promise<string | null> | null = null;
async function authToken(): Promise<string | null> {
  if (!_tokenPromise) {
    _tokenPromise = (async () => {
      try {
        const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ returnSecureToken: true }),
        });
        if (!r.ok) return null;
        const j = await r.json();
        return j.idToken || null;
      } catch {
        return null;
      }
    })();
  }
  return _tokenPromise;
}

async function url(path: string, needsAuth: boolean): Promise<string> {
  const p = path ? '/' + path.replace(/^\/+/, '') : '';
  let u = `${DB_BASE}/${STATE_NS}${p}.json`;
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
