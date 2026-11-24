// Actor: one isolated browser context = one real user/session driving the real UI.
// Handles the password gate, expands the admin config panel, instruments audio (so we can prove the
// alarm "sounded" headlessly), captures console/page errors, and exposes network-chaos controls.
import { Browser, BrowserContext, Page, CDPSession } from '@playwright/test';
import { stateNs } from './dbOracle';

const PASSWORD = 'speedchat2025';
const APP_PAGE = process.env.APP_PAGE || '/';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.TEST_PORT || 8080}`;

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
  // `skipArmingClick` / `seedPasswordFlag` reproduce the venue screen nobody has clicked: no
  // gesture, and a password already cached, so the modal never appears to supply one.
  static async create(
    browser: Browser,
    opts: {
      label: string; role: Role;
      query?: string; stallAuthMs?: number;
      skipArmingClick?: boolean; seedPasswordFlag?: boolean;
    },
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

    // Reproduce the venue machine: the password was entered once long ago, so the modal
    // never shows again and the page can run all night without a single click.
    if (opts.seedPasswordFlag) {
      await a.context.addInitScript(() => {
        try { localStorage.setItem('speedchat_password_verified', 'true'); } catch (e) { /* ignore */ }
      });
    }

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

    // Point the app at the same DB namespace the oracle asserts against. Appended here rather than
    // left to each spec so no scenario can silently fall back to the live /state node.
    const url =
      `${BASE_URL}${APP_PAGE}?role=${opts.role}` +
      `&stateNs=${encodeURIComponent(stateNs())}` +
      `${opts.query ? '&' + opts.query : ''}`;
    await a.page.goto(url, { waitUntil: 'domcontentloaded' });

    // The app reveals its password gate from a window 'load' handler, NOT at DOMContentLoaded, and
    // the page pulls ~500KB of alarm audio plus the Firebase SDK, so 'load' can land hundreds of ms
    // after 'domcontentloaded'. Checking for the gate before 'load' finds nothing, skips the whole
    // password branch, and the modal then appears on top of everything (z-index 3000) and silently
    // eats every subsequent click -- including the one that opens the config panel. Wait for 'load'
    // first so the gate is either up or genuinely absent.
    await a.page.waitForLoadState('load').catch(() => {});

    // Dismiss the password modal if present.
    const pw = a.page.locator('#passwordInput');
    if (await pw.isVisible().catch(() => false)) {
      await pw.fill(PASSWORD);
      await a.page.locator('#passwordModal button', { hasText: 'Submit' }).click().catch(async () => {
        await pw.press('Enter');
      });
    }
    // Assert the gate is really gone before touching anything behind it: a modal left standing is
    // invisible to Playwright's visibility checks but intercepts every pointer event.
    await a.page.locator('#passwordModal').waitFor({ state: 'hidden', timeout: 10_000 });

    // A real click here also satisfies the browser autoplay policy (it arms AlarmAudio).
    // skipArmingClick leaves the page un-armed on purpose, which is the state the venue
    // screen is actually in when the alarm shows on screen but stays silent.
    if (!opts.skipArmingClick) {
      await a.page.mouse.click(5, 5).catch(() => {});
    }

    // Admins/dispatchers: make sure the config panel is expanded so line controls are interactable.
    if (opts.role !== 'viewer') await a.openConfigPanel();
    return a;
  }

  // Open the admin config panel and VERIFY it opened. The gear toggles, so a blind click is a
  // coin flip once anything else has touched the panel; and a swallowed click failure here used to
  // surface much later as "<some control> is not visible" deep inside a scenario.
  async openConfigPanel(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      if (await this.configPanelOpen()) return;
      await this.page
        .locator('.config-header')
        .click({ timeout: 2_000 })
        .catch((e: any) => { lastErr = String((e && e.message) || e).split('\n')[0]; });
      if (await this.configPanelOpen()) return;
      await this.page.waitForTimeout(100);
    }
    const diag = await this.page
      .evaluate(() => {
        const cc = document.getElementById('configContent');
        const pm = document.getElementById('passwordModal');
        return {
          configContentClass: cc ? cc.className : null,
          passwordModalVisible: !!(pm && pm.className.includes('visible')),
          readyState: document.readyState,
        };
      })
      .catch(() => null);
    throw new Error(`openConfigPanel(${this.label}): panel never opened. state=${JSON.stringify(diag)} lastClickError=${lastErr}`);
  }

  // The panel is open when the app has put `visible` on #configContent (the only thing that lifts
  // its display:none) AND the controls inside it actually have a layout box. Add Line is checked
  // for admins only -- the app hides it outright for dispatchers.
  async configPanelOpen(): Promise<boolean> {
    return this.page
      .evaluate((needsAddLine) => {
        const cc = document.getElementById('configContent');
        if (!cc || !cc.classList.contains('visible')) return false;
        const lc = document.getElementById('linesContainer');
        if (!lc || lc.offsetParent === null) return false;
        if (!needsAddLine) return true;
        const btn = document.querySelector('.add-line-btn') as HTMLElement | null;
        return !!(btn && btn.offsetParent !== null);
      }, this.role === 'admin')
      .catch(() => false);
  }

  // ---- read helpers ----
  async alarmPlays(): Promise<AlarmPlay[]> {
    return this.page.evaluate(() => (window as any).__alarmPlays || []);
  }
  // Count rings from the app's OWN log when it is available. The app now plays through Web
  // Audio first and only falls back to a fresh <audio> element, so counting play() calls
  // alone would miss a ring that never touched an element. The __alarmPlays fallback keeps
  // this working against tests/fixtures/index.unfixed.html for before/after evidence.
  async alarmPlayCount(id = 'bell'): Promise<number> {
    return this.page.evaluate((clip) => {
      const log = (window as any).__alarmLog;
      if (Array.isArray(log)) {
        return log.filter((e: any) => e.event === 'ring' && e.detail && e.detail.clip === clip).length;
      }
      return ((window as any).__alarmPlays || []).filter((p: any) => p.id === clip).length;
    }, id);
  }

  // ---- audio health / diagnostics ----
  async alarmLog(): Promise<Array<{ seq: number; t: number; event: string; detail: any }>> {
    return this.page.evaluate(() => ((window as any).__alarmLog || []).slice());
  }
  async alarmLogEvents(name: string): Promise<any[]> {
    const log = await this.alarmLog();
    return log.filter((e) => e.event === name).map((e) => e.detail);
  }
  async audioHealth(): Promise<any> {
    return this.page.evaluate(() => (window as any).__audioHealth || null);
  }
  async armBannerVisible(): Promise<boolean> {
    return this.page.locator('#audioArmBanner').isVisible().catch(() => false);
  }
  async audioBadgeText(): Promise<string> {
    return this.page.locator('#audioBadge').textContent().then((t) => (t || '').trim()).catch(() => '');
  }
  async warn30Visible(): Promise<boolean> {
    return this.page.locator('#warn30Toast').isVisible().catch(() => false);
  }
  // Simulate the ENVIRONMENT failing (a dead sink), never a bypass of app logic.
  async forceAudioFailure(force: { failPrimary?: boolean; failElement?: boolean }): Promise<void> {
    await this.page.evaluate((f) => { (window as any).__audioForce = f; }, force);
  }
  // Arming is asynchronous (the AudioContext has to actually reach 'running'), so any
  // assertion about a ring that must produce sound has to wait for it first.
  async waitForArmed(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const h = await this.audioHealth();
      if (h && h.armed) return;
      await this.page.mouse.click(5, 5).catch(() => {});
      await this.page.waitForTimeout(250);
    }
    throw new Error('waitForArmed: audio never armed');
  }
  async dispatchDeviceChange(): Promise<void> {
    await this.page.evaluate(() => {
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    });
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
  // The Add Line button lives in the config panel but OUTSIDE #linesContainer, so a Firebase
  // re-render never rebuilds it: with the panel verifiably open, one real click is enough.
  async addLine(): Promise<void> {
    await this.openConfigPanel();
    await this.page.locator('.add-line-btn').click();
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
