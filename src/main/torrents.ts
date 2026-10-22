import { app } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The slice of WebTorrent's Torrent that Bro uses (the package ships no types). */
interface Torrent {
  infoHash: string;
  name: string;
  length: number;
  downloaded: number;
  downloadSpeed: number;
  numPeers: number;
  done: boolean;
  ready: boolean;
  destroyed: boolean;
  torrentFile?: Uint8Array;
  on(event: 'metadata' | 'done' | 'ready', cb: () => void): void;
  on(event: 'error', cb: (err: Error | string) => void): void;
  destroy(opts: { destroyStore: boolean }, cb?: (err?: Error) => void): void;
}

interface Client {
  add(id: string | Uint8Array, opts: { path: string }): Torrent;
  on(event: 'error', cb: (err: Error | string) => void): void;
  destroy(cb?: (err?: Error) => void): void;
}

export interface TorrentEvents {
  /** Name, size and file list are known (magnet links learn them from peers). */
  metadata(info: { name: string; length: number; infoHash: string; saved: string }): void;
  progress(p: { received: number; total: number; speed: number; peers: number }): void;
  done(): void;
  error(message: string): void;
}

const TICK_MS = 1000;

/**
 * BitTorrent through WebTorrent (TCP/uTP peers, DHT, trackers — no WebRTC, see
 * stubs/webrtc-polyfill). The client is created on first use. Torrents stop when
 * they finish (no seeding); the .torrent is kept in userData/torrents so a stopped
 * one resumes after a restart — WebTorrent re-checks the pieces already on disk.
 */
export class TorrentEngine {
  private client: Promise<Client> | null = null;
  private readonly running = new Map<string, { t: Torrent; tick: NodeJS.Timeout }>();
  readonly metaDir = join(app.getPath('userData'), 'torrents');

  private getClient(): Promise<Client> {
    this.client ??= import('webtorrent').then(({ default: WebTorrent }) => {
      const c = new WebTorrent() as Client;
      // Torrent errors also surface here when a torrent has no listener — never let them throw.
      c.on('error', (e) => console.warn('[torrent]', errText(e)));
      return c;
    });
    return this.client;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Start (or continue) a torrent. `source` is a magnet link or the path of a saved .torrent file. */
  async start(id: string, source: string, dir: string, keepMeta: boolean, on: TorrentEvents): Promise<void> {
    if (this.running.has(id)) return;
    let client: Client;
    let input: string | Uint8Array = source;
    try {
      client = await this.getClient();
      if (!/^magnet:/i.test(source)) input = await readFile(source);
      await mkdir(dir, { recursive: true });
    } catch (e) {
      return on.error(errText(e));
    }
    if (this.running.has(id)) return;

    const t = client.add(input, { path: dir });
    const tick = setInterval(() => {
      on.progress({ received: t.downloaded, total: t.ready ? t.length : -1, speed: t.downloadSpeed, peers: t.numPeers });
    }, TICK_MS);
    this.running.set(id, { t, tick });

    t.on('metadata', () => {
      // Private-tab torrents leave nothing in Bro's data folder.
      void (keepMeta ? this.keepTorrentFile(t) : Promise.resolve('')).then((saved) => {
        if (this.running.get(id)?.t === t) on.metadata({ name: t.name, length: t.length, infoHash: t.infoHash, saved });
      });
    });
    t.on('done', () => {
      if (this.running.get(id)?.t !== t) return;
      on.progress({ received: t.length, total: t.length, speed: 0, peers: 0 });
      void this.stop(id).then(() => on.done());
    });
    t.on('error', (e) => {
      if (this.running.get(id)?.t !== t) return;
      void this.stop(id).then(() => on.error(friendly(errText(e))));
    });
  }

  /** Stop a torrent. `deleteFiles` removes what it downloaded (cancel). */
  stop(id: string, deleteFiles = false): Promise<void> {
    const run = this.running.get(id);
    if (!run) return Promise.resolve();
    this.running.delete(id);
    clearInterval(run.tick);
    // A torrent that failed is already destroyed, and destroy() then never calls back.
    if (run.t.destroyed) return Promise.resolve();
    return new Promise((resolve) => run.t.destroy({ destroyStore: deleteFiles }, () => resolve()));
  }

  /** Forget a torrent's saved .torrent file. */
  forget(source: string | undefined): void {
    if (source && source.startsWith(this.metaDir)) void rm(source, { force: true }).catch(() => {});
  }

  /** Quit: stop every torrent (their pieces stay on disk for next time). */
  async dispose(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
    const c = this.client && (await this.client.catch(() => null));
    c?.destroy();
  }

  /** Save the torrent's metadata so it can continue without asking peers for it again. */
  private async keepTorrentFile(t: Torrent): Promise<string> {
    if (!t.torrentFile) return '';
    const file = join(this.metaDir, `${t.infoHash}.torrent`);
    try {
      await mkdir(this.metaDir, { recursive: true });
      await writeFile(file, t.torrentFile);
      return file;
    } catch {
      return '';
    }
  }
}

/** Info hash of a magnet link, lower-case hex (or base32 as given), if it has one. */
export function magnetInfoHash(magnet: string): string | undefined {
  return /xt=urn:btih:([a-z0-9]+)/i.exec(magnet)?.[1].toLowerCase();
}

/** The "dn" (display name) of a magnet link. */
export function magnetName(magnet: string): string | undefined {
  try {
    return new URL(magnet).searchParams.get('dn') || undefined;
  } catch {
    return undefined;
  }
}

function friendly(msg: string): string {
  if (/duplicate torrent/i.test(msg)) return 'This torrent is already downloading.';
  if (/invalid torrent identifier|Invalid torrent/i.test(msg)) return 'That isn’t a valid torrent or magnet link.';
  return msg;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
