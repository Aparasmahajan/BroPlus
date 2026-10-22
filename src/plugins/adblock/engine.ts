import { app, ipcMain, net, type Session } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import type { AdblockStats } from '../../shared/ipc-contract';

/** Broadcast to the chrome (shield count) and Settings whenever the stats change. */
export const STATS_EVENT = 'adblock:stats';

/**
 * Ad + tracker blocking via the Ghostery engine (EasyList + uBO lists),
 * attached to every session tabs use (the default one, each profile's, the private one). This is where the
 * "faster/lighter than Chrome" claim is earned: fewer requests, fewer scripts,
 * fewer bytes.
 *
 * Filter lists are downloaded with Electron's `net.fetch` (NOT Node's global
 * fetch) so the request goes through Chromium's network stack — which honours
 * the system / corporate proxy, PAC files and proxy auth. The built engine is
 * cached to disk so later launches are instant and work offline.
 */
/**
 * Ghostery registers these process-wide ipcMain handlers every time it attaches
 * to a session. For a second session ipcMain.handle throws ("second handler")
 * BEFORE that session's network blocking is set up. Every registration forwards
 * to the same engine, so dropping the previous one first is safe — we always
 * attach/detach all sessions together.
 */
/**
 * YouTube ad shield (./preload.ts, built to dist/preload/adblock.js by esbuild's
 * plugin-preload step) — see there for why lists alone can't do it.
 */
const YOUTUBE_PRELOAD = join(__dirname, '../preload/adblock.js');

const COSMETIC_CHANNELS = [
  '@ghostery/adblocker/inject-cosmetic-filters',
  '@ghostery/adblocker/is-mutation-observer-enabled',
];

export class AdBlock {
  private blocker: ElectronBlocker | null = null;
  private enabled = true;
  private loading = false;
  private blocked = 0;
  private error?: string;
  private readonly sessions = new Set<Session>();
  /** Session → registered YouTube-shield preload id. */
  private readonly ytPreloads = new Map<Session, string>();

  constructor(
    private emit: (channel: string, payload: unknown) => void,
    enabled: boolean,
  ) {
    this.enabled = enabled;
    this.syncYouTube();
  }

  /** Also block in this session (e.g. private tabs). Safe to call before init(). */
  addSession(s: Session): void {
    this.sessions.add(s);
    if (this.enabled) this.enableIn(s);
    this.syncYouTube();
  }

  async init(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = undefined;
    this.emitStats();

    const cachePath = join(app.getPath('userData'), 'data', 'adblock-engine.bin');
    // Proxy-aware fetch via Chromium's network stack.
    const fetchImpl = ((url: string, init?: RequestInit) =>
      net.fetch(url, init as Parameters<typeof net.fetch>[1])) as unknown as typeof fetch;

    try {
      this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchImpl, {
        path: cachePath,
        read: readFile,
        write: writeFile,
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      console.error('[adblock] failed to load filter lists', e);
      this.loading = false;
      this.emitStats();
      return;
    }

    this.blocker.on('request-blocked', () => {
      this.blocked++;
      this.emitStats();
    });

    this.loading = false;
    if (this.enabled) this.attach();
    this.emitStats();
  }

  /** Force a fresh download of the filter lists (used by the Settings retry). */
  async reload(): Promise<void> {
    // Detach the old engine first, or it keeps blocking (and counting) in
    // parallel with the new one.
    this.detach();
    this.blocker = null;
    await this.init();
  }

  getStats(): AdblockStats {
    return {
      enabled: this.enabled,
      blocked: this.blocked,
      ready: this.blocker !== null,
      loading: this.loading,
      error: this.error,
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.attach();
    else this.detach();
    this.syncYouTube();
    this.emitStats();
  }

  /**
   * The YouTube shield follows the on/off switch, not the filter lists, so it
   * works even if the lists failed to download. Applies from the next page load.
   */
  private syncYouTube(): void {
    for (const s of this.sessions) {
      const id = this.ytPreloads.get(s);
      if (this.enabled && id === undefined) {
        this.ytPreloads.set(s, s.registerPreloadScript({ type: 'frame', filePath: YOUTUBE_PRELOAD }));
      } else if (!this.enabled && id !== undefined) {
        s.unregisterPreloadScript(id);
        this.ytPreloads.delete(s);
      }
    }
  }

  private attach(): void {
    for (const s of this.sessions) this.enableIn(s);
  }

  private enableIn(s: Session): void {
    if (!this.blocker || this.blocker.isBlockingEnabled(s)) return;
    for (const ch of COSMETIC_CHANNELS) ipcMain.removeHandler(ch);
    this.blocker.enableBlockingInSession(s);
  }

  /** disableBlockingInSession throws if blocking isn't on, so check first. */
  private detach(): void {
    for (const s of this.sessions) {
      if (this.blocker?.isBlockingEnabled(s)) this.blocker.disableBlockingInSession(s);
    }
  }

  private emitStats(): void {
    this.emit(STATS_EVENT, this.getStats());
  }
}
