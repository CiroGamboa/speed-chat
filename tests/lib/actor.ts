// Actor: one isolated browser context = one real user/session driving the real UI.
// Handles the password gate, expands the admin config panel, instruments audio (so we can prove the
// alarm "sounded" headlessly), captures console/page errors, and exposes network-chaos controls.
import { Browser, BrowserContext, Page, CDPSession } from '@playwright/test';

const PASSWORD = 'speedchat2025';
const APP_PAGE = process.env.APP_PAGE || '/';
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

export type Role = 'admin' | 'dispatcher' | 'viewer';

export interface AlarmPlay { id: string; t: number; }

export class Actor {
  readonly label: string;
  readonly role: Role;
  context!: BrowserContext;
  page!: Page;
  cdp!: CDPSession;
  errors: string[] = [];
  logs: string[] = [];

  private constructor(label: string, role: Role) {
    this.label = label;
    this.role = role;
  }

  // `query` appends extra URL parameters (e.g. 'diag=1', which the app requires before exposing
  // its scheduling test hook on a non-localhost deployment).
  // `stallAuthMs` delays the anonymous sign-in round-trip, which widens the window in which the
  // app's writes carry no auth token (see the dbWrite gate in index.html) and makes it testable.
  static async create(
    browser: Browser,
    opts: { label: string; role: Role; query?: string; stallAuthMs?: number },
  ): Promise<Actor> {
    const a = new Actor(opts.label, opts.role);
    a.context = await browser.newContext();
    a.page = await a.context.newPage();

    // Record every media play() call (the alarm) into window.__alarmPlays, before app scripts run.
    await a.context.addInitScript(() => {
      (window as any).__alarmPlays = [];
      const proto = HTMLMediaElement.prototype as any;
      // Record the call and resolve. We intentionally do NOT invoke the real play(): headless audio
      // isn't audible anyway, and actually playing then pausing produces benign
      // "play() interrupted by pause()" rejections that would masquerade as page errors.
      proto.play = function () {
        try { (window as any).__alarmPlays.push({ id: this.id || '', t: Date.now() }); } catch (e) { /* ignore */ }
        return Promise.resolve();
      };
    });

    a.page.on('pageerror', (err) => a.errors.push(`[pageerror] ${err.message}`));
    a.page.on('console', (msg) => {
      a.logs.push(`[${msg.type()}] ${msg.text()}`);
      if (msg.type() === 'error') a.errors.push(`[console.error] ${msg.text()}`);
    });

    a.cdp = await a.context.newCDPSession(a.page);

    // Must be installed BEFORE the first navigation, or sign-in has already gone out.
    if (opts.stallAuthMs) {
      const delay = opts.stallAuthMs;
      await a.context.route('**/identitytoolkit.googleapis.com/**', async (route) => {
        await new Promise((r) => setTimeout(r, delay));
        await route.continue().catch(() => {});
      });
    }

    const url = `${BASE_URL}${APP_PAGE}?role=${opts.role}${opts.query ? '&' + opts.query : ''}`;
    await a.page.goto(url, { waitUntil: 'domcontentloaded' });

    // Dismiss the password modal if present.
    const pw = a.page.locator('#passwordInput');
    if (await pw.isVisible().catch(() => false)) {
      await pw.fill(PASSWORD);
      await a.page.locator('#passwordModal button', { hasText: 'Submit' }).click().catch(async () => {
        await pw.press('Enter');
      });
      await a.page.locator('#passwordModal').waitFor({ state: 'hidden' }).catch(() => {});
    }

    // A real click here also satisfies the browser autoplay policy (audioEnabled = true).
    await a.page.mouse.click(5, 5).catch(() => {});

    // Admins/dispatchers: make sure the config panel is expanded so line controls are interactable.
    if (opts.role !== 'viewer') {
      const linesVisible = await a.page.locator('#linesContainer').isVisible().catch(() => false);
      const anyLine = await a.page.locator('#linesContainer .line-config').count().catch(() => 0);
      if (!linesVisible || anyLine === 0) {
        await a.page.locator('.config-header').click().catch(() => {});
      }
    }
    return a;
  }

  // ---- read helpers ----
  async alarmPlays(): Promise<AlarmPlay[]> {
    return this.page.evaluate(() => (window as any).__alarmPlays || []);
  }
  async alarmPlayCount(id = 'bell'): Promise<number> {
    const plays = await this.alarmPlays();
    return plays.filter((p) => p.id === id).length;
  }
  async notificationVisible(): Promise<boolean> {
    return this.page.locator('#changeSeatNotification').isVisible().catch(() => false);
  }
  // Count of people rows currently shown across all timer cards (what THIS user sees on screen).
  async visiblePeopleCount(): Promise<number> {
    return this.page.locator('#timers-container .person-entry').count().catch(() => 0);
  }

  // ---- config / line management ----
  async ensureConfigOpen(): Promise<void> {
    const count = await this.page.locator('#linesContainer .line-config').count().catch(() => 0);
    const inputVisible = await this.page.locator('#linesContainer .line-config .add-person input').first().isVisible().catch(() => false);
    if (count > 0 && !inputVisible) {
      await this.page.locator('.config-header').click().catch(() => {});
    }
  }
  async lineCount(): Promise<number> {
    return this.page.locator('#linesContainer .line-config').count().catch(() => 0);
  }
  // Retry around the real button. The config panel may be collapsed, or mid-rebuild from a
  // Firebase re-render, when this is called -- the button then exists but is not clickable, and a
  // single click times out. (ensureConfigOpen() does NOT cover this: it no-ops when zero lines
  // exist, which is precisely the empty-database case every spec starts from.) Without this the
  // alarm churn spec flakes on main as well as on feature branches.
  async addLine(): Promise<void> {
    const btn = this.page.locator('.add-line-btn');
    // Hard deadline: retrying for longer hides a genuine failure behind the spec's own timeout,
    // which is far harder to diagnose than a fast, explicit error.
    const deadline = Date.now() + 12_000;
    let lastErr = '';
    while (Date.now() < deadline) {
      if (await btn.isVisible().catch(() => false)) {
        try { await btn.click({ timeout: 1500 }); return; } catch (e: any) { lastErr = String(e && e.message || e).split('\n')[0]; }
      } else {
        // Not visible => panel collapsed or still rendering. Expanding is gated by the check
        // above, so this cannot toggle an already-open panel shut.
        await this.page.locator('.config-header').click().catch(() => {});
      }
      await this.page.waitForTimeout(200);
    }
    const diag = await this.page.evaluate(() => {
      const lc = document.getElementById('linesContainer');
      const b = document.querySelector('.add-line-btn') as HTMLElement | null;
      return { panelVisible: !!(lc && lc.offsetParent !== null), btnExists: !!b, btnVisible: !!(b && b.offsetParent) };
    }).catch(() => null);
    throw new Error(`addLine: button never became clickable after 12s. state=${JSON.stringify(diag)} lastClickError=${lastErr}`);
  }
  async setMaxPeople(n: number): Promise<void> {
    await this.page.selectOption('#maxPeople', String(n)).catch(async () => {
      // If the value isn't an existing option, set it directly and fire change.
      await this.page.evaluate((v) => {
        const el = document.getElementById('maxPeople') as HTMLInputElement | HTMLSelectElement | null;
        if (el) { (el as any).value = String(v); el.dispatchEvent(new Event('change', { bubbles: true })); }
      }, n);
    });
  }

  // Add a person to the Nth line (0-indexed) through the REAL add-person control. We set the input
  // value and click Add inside ONE synchronous evaluate, so a Firebase re-render can't recreate the
  // input and blank our typed name between fill and click (that would drop the submit — a UI timing
  // artifact, not a sync loss). The click still runs the app's real addPerson() transaction path.
  async addPersonToLine(lineIndex: number, name: string): Promise<void> {
    await this.ensureConfigOpen();
    // Retry: the linesContainer is briefly empty while a Firebase update re-renders it, so a single
    // attempt can hit a missing card. Retry until the submit actually goes through.
    for (let attempt = 0; attempt < 15; attempt++) {
      const ok = await this.page.evaluate(({ idx, name }) => {
        const lc = document.querySelectorAll('#linesContainer .line-config')[idx] as HTMLElement | undefined;
        if (!lc) return false;
        const inp = lc.querySelector('.add-person input') as HTMLInputElement | null;
        const btn = lc.querySelector('.add-person button') as HTMLButtonElement | null;
        if (!inp || !btn) return false;
        inp.value = name;
        btn.click(); // synchronous: addPerson() reads inp.value right now
        return true;
      }, { idx: lineIndex, name });
      if (ok) return;
      await this.page.waitForTimeout(150);
    }
    throw new Error(`addPersonToLine: line ${lineIndex} not present after retries`);
  }

  // Add many people to the same line back-to-back (used to create real contention across actors).
  async rapidAddToLine(lineIndex: number, names: string[], gapMs = 0): Promise<void> {
    for (const n of names) {
      await this.addPersonToLine(lineIndex, n);
      if (gapMs) await this.page.waitForTimeout(gapMs);
    }
  }

  // Exercise the real per-line wait-queue code path (no dedicated UI exists for it).
  async addToLineWaitQueueViaApp(lineId: string, name: string): Promise<void> {
    await this.page.evaluate(({ lineId, name }) => {
      let inp = document.getElementById('newWaitQueuePerson' + lineId) as HTMLInputElement | null;
      if (!inp) { inp = document.createElement('input'); inp.id = 'newWaitQueuePerson' + lineId; document.body.appendChild(inp); }
      inp.value = name;
      (window as any).addToWaitQueue(lineId);
    }, { lineId, name });
  }

  async addGeneralQueuePerson(name: string): Promise<void> {
    // Call the (hoisted) global directly so we don't depend on the delayed button/Enter hookup.
    await this.page.evaluate((n) => {
      const inp = document.getElementById('newGeneralWaitQueuePerson') as HTMLInputElement | null;
      if (inp) inp.value = n;
      (window as any).addGeneralWaitQueuePerson();
    }, name);
  }

  // ---- alarm controls ----
  async setAlarmToggle(on: boolean): Promise<void> {
    // The checkbox is visually replaced by a styled slider, so click it via the DOM and fire change.
    await this.page.evaluate((on) => {
      const t = document.getElementById('alarmToggle') as HTMLInputElement | null;
      if (t && t.checked !== on) { t.checked = on; t.dispatchEvent(new Event('change', { bubbles: true })); }
    }, on);
  }
  async clickManualAlarm(): Promise<void> {
    // Invoke the exact handler the button's onclick calls. (A real click can be intercepted by the
    // expanded config panel that overlaps the header button; this reliably exercises the fix.)
    await this.page.evaluate(() => (window as any).playAlarmManually());
  }

  // ---- network chaos ----
  async goOffline(): Promise<void> { await this.context.setOffline(true); }
  async goOnline(): Promise<void> { await this.context.setOffline(false); }
  async setNetworkProfile(profile: 'slow-3g' | 'good' | 'high-latency'): Promise<void> {
    const profiles: Record<string, any> = {
      good: { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
      'slow-3g': { offline: false, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },
      'high-latency': { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 800 },
    };
    await this.cdp.send('Network.enable').catch(() => {});
    await this.cdp.send('Network.emulateNetworkConditions', profiles[profile]);
  }

  // Console/page errors EXCLUDING expected network noise from deliberate offline/latency injection
  // (Firebase logs WebSocket/resource failures while a context is offline — that's expected here).
  appErrors(): string[] {
    const noise = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|WebSocket connection|Failed to load resource|net::ERR/i;
    return this.errors.filter((e) => !noise.test(e));
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }
}

// Convenience: run async work for many actors "simultaneously".
export async function concurrently<T>(fns: Array<() => Promise<T>>): Promise<T[]> {
  return Promise.all(fns.map((f) => f()));
}
