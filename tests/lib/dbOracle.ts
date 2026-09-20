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

function url(path: string): string {
  const p = path ? '/' + path.replace(/^\/+/, '') : '';
  return `${DB_BASE}/${STATE_NS}${p}.json`;
}

async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(url(path), {
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
