import {
  app,
  dialog,
  net,
  shell,
  type BrowserWindow,
  type ClientRequest,
  type DownloadItem,
  type Event as ElectronEvent,
  type IncomingMessage,
  type Session,
  type WebContents,
} from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { randomBytes } from 'node:crypto';
import { JsonStore } from './store';
import { TorrentEngine, magnetInfoHash, magnetName } from './torrents';
import {
  DOWNLOAD_PRIORITIES,
  Event,
  type DownloadAction,
  type DownloadInfo,
  type DownloadPriority,
  type Prefs,
} from '../shared/ipc-contract';

/** Bro's engine writes here until every byte is in, then renames to the real name. */
const PART_EXT = '.brodownload';
/** Chromium's engine writes here (we move it into place when it completes). */
const BROWSER_PART_EXT = '.crdownload';
const MIN_SEGMENT = 1 << 20; // never split below 1 MB
const STALL_MS = 30_000; // a connection that sends nothing this long is restarted
const MAX_FAILS = 8; // consecutive failures without progress before we pause and retry later
const RETRY_LATER_MS = 60_000; // FDM-style: interrupted downloads keep retrying in the background
const EMIT_MS = 400;
const PERSIST_MS = 1_000;
const KEEP = 300; // list entries kept on disk
const EXPECT_MS = 30_000; // a re-requested Chromium download that never shows up stops holding its slot
const RANK: Record<DownloadPriority, number> = { high: 0, normal: 1, low: 2 };

interface Segment {
  start: number;
  end: number; // inclusive
  done: number; // bytes written to disk
}

/** What's stored per download: the public info + what the engines need to resume. */
interface Rec extends DownloadInfo {
  partition: string;
  referrer?: string;
  segments?: Segment[];
  etag?: string;
  lastModified?: string;
  /** When it joined the queue (ties within a priority go first-come, first-served). */
  queuedAt?: number;
  /** Torrent: the magnet link, or the saved .torrent it continues from. */
  torrentSource?: string;
  infoHash?: string;
}

interface Ctx {
  private: boolean;
  profileId: string;
  partition: string;
}

const PUBLIC_KEYS: (keyof DownloadInfo)[] = [
  'id', 'url', 'filename', 'path', 'total', 'received', 'speed', 'status', 'error', 'engine',
  'connections', 'resumable', 'retries', 'started', 'finished', 'private', 'profileId', 'priority', 'forced',
];

/**
 * Downloads, resumable like a download manager:
 *
 *  - SEGMENTED engine (Bro's own) for http(s) files whose server supports byte
 *    ranges: up to N parallel connections, each segment's progress saved, so a
 *    download survives network drops, pauses, crashes and restarts. Finished
 *    segments steal work from the biggest remaining one.
 *  - BROWSER engine (Chromium's DownloadItem) for everything else (no range
 *    support, blob:/data: URLs, POST-only links): pause/resume within a run,
 *    automatic resume after network interruptions; "Retry" starts it again.
 *  - TORRENT engine (torrents.ts) for magnet links and .torrent files.
 *
 * Like Free Download Manager, at most `Prefs.maxDownloads` run at once; the rest
 * are 'queued' and start by priority (high → normal → low), then first-come.
 * "Start now" runs one outside the limit.
 */
export class DownloadManager {
  private readonly store = new JsonStore<Rec[]>('downloads', []);
  private readonly recs = new Map<string, Rec>();
  private readonly jobs = new Map<string, SegmentedJob>();
  private readonly items = new Map<string, DownloadItem>();
  private readonly torrents = new TorrentEngine();
  private readonly sessions = new Map<string, Session>(); // partition → session (for resume)
  private readonly askNext = new Set<string>(); // URLs from "Save … as"
  /** Chromium downloads Bro asked for again (Retry / restart): URL → how to treat it when it arrives. */
  private readonly expecting = new Map<string, { priority: DownloadPriority; now: boolean; timer: NodeJS.Timeout }>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  /** Chromium items Bro paused itself (deciding on the engine): their "paused" isn't the user's. */
  private readonly held = new Set<string>();
  /** Running when Bro last closed: they continue before the rest of the queue. */
  private readonly wasRunning: Rec[] = [];
  private scheduling = false;
  private emitTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private emit: (channel: string, payload: unknown) => void,
    private prefs: () => Prefs,
    private window: () => BrowserWindow | null,
    /** Session for a stored partition — lets downloads resume before their profile is opened. */
    private resolveSession: (partition: string) => Session,
  ) {
    for (const r of this.store.get()) {
      r.priority = DOWNLOAD_PRIORITIES.includes(r.priority) ? r.priority : 'normal';
      r.forced = false;
      // Anything unfinished from the last run: segmented downloads and torrents continue
      // (running ones rejoin the queue); Chromium's can't (its item is gone) — a queued one
      // is requested again when its turn comes, a started one becomes "Retry".
      if (r.status === 'downloading' || r.status === 'paused' || r.status === 'interrupted' || r.status === 'queued') {
        if (r.engine === 'segmented' || r.engine === 'torrent') {
          if (r.status === 'downloading' || r.status === 'interrupted') this.wasRunning.push(r);
          if (r.status !== 'paused') r.status = 'queued';
          r.resumable = true;
        } else if (r.status !== 'queued') {
          r.status = 'failed';
          r.resumable = false;
          r.error = 'Bro was closed while this was downloading — Retry to start again.';
        }
      }
      r.speed = 0;
      r.connections = 0;
      this.recs.set(r.id, r);
    }
  }

  /** Watch a session's downloads (call once per session). */
  attach(sess: Session, ctx: Ctx): void {
    this.sessions.set(ctx.partition, sess);
    sess.on('will-download', (e, item, wc) => this.onWillDownload(e, item, wc, ctx));
  }

  /** After startup: continue downloads that were running (or waiting) when Bro last closed or crashed. */
  init(): void {
    setTimeout(() => {
      // Ones that were running get their slots back first; then the queue goes by priority.
      for (const r of this.wasRunning.sort(byQueue)) if (r.status === 'queued' && this.busy() < this.limit()) this.run(r);
      this.wasRunning.length = 0;
      this.schedule();
    }, 3000);
  }

  /** A profile is being removed: stop its downloads (finished files stay on disk). */
  dropProfile(profileId: string): void {
    for (const r of this.recs.values()) if (r.profileId === profileId && isLive(r)) this.cancel(r);
  }

  private sessionOf(r: Rec): Session {
    return this.sessions.get(r.partition) ?? this.resolveSession(r.partition);
  }

  list(): DownloadInfo[] {
    return [...this.recs.values()].sort((a, b) => b.started - a.started).map(publicInfo);
  }

  /** "Save link/image as…": ask where to save this one. */
  saveAs(url: string, wc: WebContents): void {
    this.askNext.add(url);
    wc.downloadURL(url);
  }

  command(id: string, action: DownloadAction): void {
    const r = this.recs.get(id);
    if (!r) return;
    switch (action) {
      case 'pause':
        this.pause(r);
        break;
      case 'resume':
        this.resume(r);
        break;
      case 'cancel':
        this.cancel(r);
        break;
      case 'retry':
        this.retry(r);
        break;
      case 'start-now':
        if (r.status === 'queued' || r.status === 'paused' || r.status === 'interrupted') {
          r.forced = true;
          this.run(r);
        }
        break;
      case 'open':
        if (r.status === 'completed') void shell.openPath(r.path);
        break;
      case 'show':
        if (existsSync(r.path)) shell.showItemInFolder(r.path);
        else if (existsSync(r.path + PART_EXT)) shell.showItemInFolder(r.path + PART_EXT);
        else void shell.openPath(dirname(r.path));
        break;
      case 'remove':
        if (isLive(r)) this.cancel(r);
        if (r.engine === 'torrent') this.torrents.forget(r.torrentSource);
        this.recs.delete(id);
        this.changed(true);
        this.schedule();
        break;
    }
  }

  setPriority(id: string, priority: DownloadPriority): void {
    const r = this.recs.get(id);
    if (!r || !DOWNLOAD_PRIORITIES.includes(priority)) return;
    r.priority = priority;
    this.changed(true);
  }

  pauseAll(): void {
    for (const r of this.recs.values()) if (isActive(r) || r.status === 'queued') this.pause(r);
  }

  /** Paused downloads rejoin the queue in priority order (the limit still applies). */
  resumeAll(): void {
    for (const r of [...this.recs.values()].sort(byQueue)) if (r.status === 'paused') this.resume(r);
  }

  openFolder(): void {
    void shell.openPath(this.dir());
  }

  /** Drop finished, cancelled and failed entries from the list (files stay). */
  clear(): void {
    for (const [id, r] of this.recs) if (!isLive(r)) this.recs.delete(id);
    this.changed(true);
  }

  /** Called on quit: save where every segment got to; running ones rejoin the queue next launch. */
  flush(): void {
    for (const job of this.jobs.values()) job.stopForExit();
    void this.torrents.dispose();
    this.persist();
    this.store.flush();
  }

  // --- Queue -----------------------------------------------------------------------

  /** How many downloads may run at once. */
  private limit(): number {
    return Math.min(10, Math.max(1, Math.round(this.prefs().maxDownloads || 4)));
  }

  /** Slots in use: running downloads (not "Start now" ones) + Chromium ones Bro re-requested. */
  private busy(except?: Rec): number {
    let n = [...this.expecting.values()].filter((e) => e.now).length;
    for (const r of this.recs.values()) {
      if (r === except || r.forced) continue;
      // A Chromium download retrying after a network blip comes back within seconds — keep its slot.
      if (r.status === 'downloading' || (r.status === 'interrupted' && r.engine === 'browser')) n++;
    }
    return n;
  }

  /** Start queued downloads while there are free slots (call after anything frees one). */
  schedule(): void {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      const waiting = [...this.recs.values()].filter((r) => r.status === 'queued').sort(byQueue);
      for (const r of waiting) {
        if (this.busy() >= this.limit()) break;
        if (r.status === 'queued') this.run(r);
      }
    } finally {
      this.scheduling = false;
    }
  }

  /** Run now if a slot is free (or it was "Start now"-ed), otherwise wait in the queue. */
  private runOrQueue(r: Rec): void {
    if (r.forced || this.busy(r) < this.limit()) return this.run(r);
    this.cancelLater(r.id);
    this.items.get(r.id)?.pause();
    r.status = 'queued';
    r.queuedAt = Date.now();
    r.speed = 0;
    this.changed(true);
  }

  /** Start (or continue) a download with its engine, whatever the limit says. */
  private run(r: Rec): void {
    this.cancelLater(r.id);
    r.error = undefined;
    if (r.engine === 'segmented') {
      if (this.jobs.has(r.id)) return;
      r.status = 'downloading';
      this.startSegmented(r);
    } else if (r.engine === 'torrent') {
      r.status = 'downloading';
      this.startTorrent(r);
    } else {
      const item = this.items.get(r.id);
      if (item && item.getState() === 'progressing') {
        r.status = 'downloading';
        if (item.isPaused()) item.resume();
      } else if (item && item.getState() === 'interrupted' && item.canResume()) {
        r.status = 'downloading';
        item.resume();
      } else {
        return this.restartBrowser(r, true);
      }
    }
    this.changed(true);
  }

  // --- Torrents --------------------------------------------------------------------

  /** A magnet link, or a .torrent file Bro fetched. Returns an error to show, or null. */
  addTorrent(source: string, ctx: Ctx, from: { url?: string; name?: string } = {}): string | null {
    const magnet = /^magnet:/i.test(source);
    const infoHash = magnet ? magnetInfoHash(source) : undefined;
    if (magnet && !infoHash) return 'That magnet link has no info hash (xt=urn:btih:…).';
    const dup = infoHash && [...this.recs.values()].find((r) => r.infoHash === infoHash && r.status !== 'cancelled' && r.status !== 'failed');
    if (dup) return `“${dup.filename}” is already in your downloads.`;
    const name = safeName((magnet ? magnetName(source) : from.name) || (infoHash ? `Torrent ${infoHash.slice(0, 8)}` : 'Torrent'));
    const r: Rec = {
      id: randomBytes(6).toString('hex'),
      url: from.url ?? source,
      filename: name,
      path: join(this.dir(), name),
      total: -1,
      received: 0,
      speed: 0,
      status: 'queued',
      engine: 'torrent',
      connections: 0,
      resumable: true,
      retries: 0,
      started: Date.now(),
      private: ctx.private,
      profileId: ctx.profileId,
      partition: ctx.partition,
      priority: 'normal',
      forced: false,
      torrentSource: source,
      infoHash,
    };
    this.recs.set(r.id, r);
    this.runOrQueue(r);
    this.changed(true);
    return null;
  }

  private startTorrent(r: Rec): void {
    const dir = dirname(r.path); // fixed when it was added, so a new download folder doesn't break resuming
    const mine = () => r.status === 'downloading' && this.recs.get(r.id) === r;
    void this.torrents.start(r.id, r.torrentSource ?? '', dir, !r.private, {
      metadata: (m) => {
        r.filename = m.name;
        r.path = join(dir, m.name);
        r.total = m.length;
        r.infoHash = m.infoHash;
        if (m.saved && m.saved !== r.torrentSource) {
          this.torrents.forget(r.torrentSource); // the fetched incoming-….torrent, if that's what it was
          r.torrentSource = m.saved; // continues without asking peers for the metadata again
        }
        this.changed(true);
      },
      progress: (p) => {
        if (!mine()) return;
        r.received = p.received;
        if (p.total > 0) r.total = p.total;
        r.speed = p.speed;
        r.connections = p.peers;
        this.changed();
      },
      done: () => {
        if (!mine()) return;
        r.status = 'completed';
        r.received = r.total;
        this.ended(r);
      },
      error: (message) => {
        if (!mine()) return;
        r.status = 'failed';
        r.error = message;
        this.ended(r);
      },
    });
  }

  /** A download stopped for good (done / failed): free its slot. */
  private ended(r: Rec): void {
    r.finished = Date.now();
    r.speed = 0;
    r.connections = 0;
    r.forced = false;
    this.changed(true);
    this.schedule();
  }

  /** A downloaded .torrent file: open it as a torrent instead of keeping the file. */
  private takeTorrentFile(item: DownloadItem, ctx: Ctx): void {
    const file = join(this.torrents.metaDir, `incoming-${randomBytes(6).toString('hex')}.torrent`);
    const url = item.getURL();
    const name = parse(item.getFilename() || 'download.torrent').name;
    void mkdir(this.torrents.metaDir, { recursive: true }).catch(() => {});
    item.setSavePath(file);
    item.once('done', (_e, state) => {
      if (state !== 'completed') return;
      const err = this.addTorrent(file, ctx, { url, name });
      if (err) {
        console.warn('[torrent]', err);
        this.torrents.forget(file);
      }
    });
  }

  // --- Chromium hands us a new download ------------------------------------------

  private onWillDownload(_e: ElectronEvent, item: DownloadItem, wc: WebContents, ctx: Ctx): void {
    const url = item.getURL();
    const isTorrent = item.getMimeType() === 'application/x-bittorrent' || /\.torrent$/i.test(item.getFilename());
    if (isTorrent && this.prefs().torrents && !this.askNext.has(url)) return this.takeTorrentFile(item, ctx);

    const expected = this.expecting.get(url);
    if (expected) {
      clearTimeout(expected.timer);
      this.expecting.delete(url);
    }
    const target = uniquePath(join(this.dir(), item.getFilename() || 'download'));
    const ask = this.askNext.delete(url) || this.prefs().askWhereToSave;
    // No free slot → it waits in the queue (Chromium's item stays paused meanwhile).
    const queued = !expected?.now && this.busy() >= this.limit();
    // Chromium needs a path right now; it writes beside the target and we move it into place.
    item.setSavePath(target + BROWSER_PART_EXT);

    const r: Rec = {
      id: randomBytes(6).toString('hex'),
      url: item.getURLChain().at(-1) ?? url,
      filename: basename(target),
      path: target,
      total: item.getTotalBytes() || -1,
      received: 0,
      speed: 0,
      status: queued ? 'queued' : 'downloading',
      engine: 'browser',
      connections: 1,
      resumable: false,
      retries: 0,
      started: Date.now(),
      private: ctx.private,
      profileId: ctx.profileId,
      partition: ctx.partition,
      referrer: safeUrl(wc?.getURL()),
      priority: expected?.priority ?? 'normal',
      forced: false,
      queuedAt: queued ? Date.now() : undefined,
    };
    this.recs.set(r.id, r);
    this.trackItem(r, item);
    this.changed(true);

    const rangeable = /^https?:/i.test(r.url) && r.total > 0;
    if (!ask && !rangeable && !queued) return; // plain Chromium download
    this.held.add(r.id);
    item.pause();
    void this.decide(r, item, ask).finally(() => this.held.delete(r.id));
  }

  /** Ask for a location if needed, then take over with the segmented engine if the server allows. */
  private async decide(r: Rec, item: DownloadItem, ask: boolean): Promise<void> {
    if (ask) {
      const win = this.window();
      const opts = { title: 'Save as', defaultPath: r.path };
      const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (picked.canceled || !picked.filePath) {
        this.detachItem(r);
        item.cancel();
        this.recs.delete(r.id); // Chrome doesn't list a cancelled "Save as" either
        this.changed(true);
        return;
      }
      r.path = picked.filePath;
      r.filename = basename(picked.filePath);
    }

    const probe = /^https?:/i.test(r.url) && r.total > 0 ? await probeRanges(this.sessionOf(r), r) : null;
    if (probe && probe.total === r.total) {
      // Range requests work and it's the same file: Bro's engine takes over.
      this.detachItem(r);
      item.cancel();
      r.engine = 'segmented';
      r.resumable = true;
      r.etag = probe.etag;
      r.lastModified = probe.lastModified;
      r.received = 0;
      if (r.status === 'downloading') this.startSegmented(r); // a queued one starts when its turn comes
    } else if (item.getState() === 'progressing' && r.status === 'downloading') {
      item.resume();
    }
    this.changed(true);
  }

  // --- Chromium engine -----------------------------------------------------------

  private trackItem(r: Rec, item: DownloadItem): void {
    this.items.set(r.id, item);
    let lastBytes = 0;
    let lastAt = Date.now();
    let fails = 0;
    item.on('updated', (_e, state) => {
      if (!this.items.has(r.id)) return; // handed over to the segmented engine
      const now = Date.now();
      const got = item.getReceivedBytes();
      if (now - lastAt >= 500) {
        r.speed = Math.max(0, ((got - lastBytes) * 1000) / (now - lastAt));
        lastBytes = got;
        lastAt = now;
      }
      r.received = got;
      r.total = item.getTotalBytes() || r.total;
      r.resumable = item.canResume();
      if (state === 'interrupted') {
        r.status = 'interrupted';
        r.speed = 0;
        // Network hiccup: Chromium can usually continue — retry with backoff.
        if (item.canResume() && fails < MAX_FAILS) {
          fails++;
          r.retries++;
          this.later(r.id, Math.min(30_000, 1000 * 2 ** fails), () => {
            if (item.getState() === 'interrupted' && item.canResume()) item.resume();
          });
        }
      } else {
        if (got > lastBytes) fails = 0;
        // An item Bro holds paused (deciding, or waiting in the queue) keeps its status.
        const heldByBro = item.isPaused() && (this.held.has(r.id) || r.status === 'queued');
        if (!heldByBro) r.status = item.isPaused() ? 'paused' : 'downloading';
      }
      this.changed();
    });
    item.once('done', (_e, state) => {
      if (!this.items.has(r.id)) return;
      this.items.delete(r.id);
      r.connections = 0;
      if (state === 'completed') {
        r.received = item.getReceivedBytes();
        r.total = r.received;
        void this.moveIntoPlace(r, item.getSavePath());
      } else if (state === 'cancelled') {
        r.status = 'cancelled';
      } else {
        r.status = 'failed';
        r.error = 'The download was interrupted and the server can’t continue it — Retry to start again.';
      }
      this.ended(r);
    });
  }

  private detachItem(r: Rec): void {
    this.items.delete(r.id);
  }

  private async moveIntoPlace(r: Rec, from: string): Promise<void> {
    try {
      if (from !== r.path) {
        if (existsSync(r.path)) {
          r.path = uniquePath(r.path);
          r.filename = basename(r.path);
        }
        await rename(from, r.path);
      }
      r.status = 'completed';
    } catch (e) {
      r.status = 'failed';
      r.error = `Downloaded, but couldn’t move it into place: ${errText(e)}`;
    }
    r.finished = Date.now();
    this.changed(true);
    this.schedule();
  }

  // --- Segmented engine ------------------------------------------------------------

  private startSegmented(r: Rec): void {
    const job = new SegmentedJob(r, this.sessionOf(r), () => this.connectionsLimit(), {
      progress: () => this.changed(),
      saved: () => this.persistSoon(),
      finished: () => {
        this.jobs.delete(r.id);
        this.ended(r);
      },
      failedForNow: () => {
        // Too many failures in a row: stop (freeing the slot), and keep retrying in the background.
        this.jobs.delete(r.id);
        this.later(r.id, RETRY_LATER_MS, () => {
          if (r.status === 'interrupted') this.resume(r);
        });
        this.changed(true);
        this.schedule();
      },
    });
    this.jobs.set(r.id, job);
    void job.run();
  }

  private pause(r: Rec): void {
    this.cancelLater(r.id);
    const job = this.jobs.get(r.id);
    if (job) {
      job.pause();
      this.jobs.delete(r.id);
    } else if (r.engine === 'torrent') {
      void this.torrents.stop(r.id);
    } else {
      const item = this.items.get(r.id);
      if (item && item.getState() === 'progressing') item.pause();
    }
    if (isActive(r) || r.status === 'queued') r.status = 'paused';
    r.speed = 0;
    r.connections = 0;
    r.forced = false;
    this.changed(true);
    this.schedule();
  }

  private resume(r: Rec): void {
    if (r.status === 'completed' || r.status === 'downloading') return;
    if (r.engine === 'browser') {
      // Chromium can continue only while its item is alive; otherwise start over (new list entry).
      const item = this.items.get(r.id);
      if (!item || !(item.canResume() || item.isPaused())) return this.retry(r);
    }
    this.runOrQueue(r);
  }

  private cancel(r: Rec): void {
    this.cancelLater(r.id);
    const job = this.jobs.get(r.id);
    if (job) {
      job.cancel();
      this.jobs.delete(r.id);
    } else if (r.engine === 'segmented') {
      void rm(r.path + PART_EXT, { force: true }).catch(() => {});
    }
    // A torrent's partial files go too (like a cancelled download's .part file).
    if (r.engine === 'torrent' && r.status !== 'completed') void this.torrents.stop(r.id, true);
    const item = this.items.get(r.id);
    if (item && item.getState() !== 'completed') item.cancel();
    if (r.status !== 'completed') r.status = 'cancelled';
    r.speed = 0;
    r.connections = 0;
    r.forced = false;
    this.changed(true);
    this.schedule();
  }

  /** Start again from scratch (failed / cancelled / unresumable). Joins the queue if it's full. */
  private retry(r: Rec): void {
    this.cancelLater(r.id);
    r.error = undefined;
    if (r.engine === 'segmented') {
      if (this.jobs.has(r.id)) return;
      r.segments = undefined;
      r.received = 0;
      r.retries = 0;
      void rm(r.path + PART_EXT, { force: true }).catch(() => {});
      return this.runOrQueue(r);
    }
    if (r.engine === 'torrent') {
      // Pieces already on disk are checked and kept — only what's missing is fetched.
      r.retries = 0;
      return this.runOrQueue(r);
    }
    this.restartBrowser(r, r.forced);
  }

  /**
   * Chromium engine: ask the session to download the URL again (a new list entry).
   * `now` = its turn in the queue has come, so it starts without queueing again.
   */
  private restartBrowser(r: Rec, now: boolean): void {
    this.recs.delete(r.id);
    const prev = this.expecting.get(r.url);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.expecting.delete(r.url);
      this.schedule();
    }, EXPECT_MS);
    this.expecting.set(r.url, { priority: r.priority, now, timer });
    this.sessionOf(r).downloadURL(r.url, r.referrer ? { headers: { Referer: r.referrer } } : undefined);
    this.changed(true);
  }

  // --- Helpers -------------------------------------------------------------------------

  private dir(): string {
    const d = this.prefs().downloadDir;
    return d && existsSync(d) ? d : app.getPath('downloads');
  }

  private connectionsLimit(): number {
    return Math.min(16, Math.max(1, Math.round(this.prefs().downloadConnections || 8)));
  }

  private later(id: string, ms: number, fn: () => void): void {
    this.cancelLater(id);
    this.retryTimers.set(
      id,
      setTimeout(() => {
        this.retryTimers.delete(id);
        fn();
      }, ms),
    );
  }

  private cancelLater(id: string): void {
    const t = this.retryTimers.get(id);
    if (t) clearTimeout(t);
    this.retryTimers.delete(id);
  }

  private changed(now = false): void {
    this.persistSoon();
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emit(Event.DownloadsChanged, this.list());
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit(Event.DownloadsChanged, this.list());
    }, EMIT_MS);
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_MS);
  }

  private persist(): void {
    // Private-tab downloads are never written to disk.
    const keep = [...this.recs.values()].filter((r) => !r.private).sort((a, b) => b.started - a.started).slice(0, KEEP);
    this.store.set(keep.map((r) => ({ ...r, segments: r.segments?.map((s) => ({ ...s })) })));
  }
}

// =====================================================================================

interface JobEvents {
  progress(): void;
  saved(): void;
  finished(): void;
  failedForNow(): void;
}

/**
 * One multi-connection download. Segments live in rec.segments (persisted), so
 * a new job for the same record continues where the last one stopped.
 */
class SegmentedJob {
  private fh: FileHandle | null = null;
  private readonly active = new Map<Segment, { req: ClientRequest; timer: NodeJS.Timeout | null }>();
  /** Bytes of a segment handed to the disk but not written yet. */
  private readonly inflight = new Map<Segment, number>();
  /** A failed segment waits until this time before it is tried again. */
  private readonly cooldown = new Map<Segment, number>();
  private readonly writes = new Set<Promise<unknown>>();
  private stopped = false;
  private finishing = false;
  private fails = 0;
  private limit: number;
  private speedBytes = 0;
  private speedAt = Date.now();
  private speedTimer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;

  constructor(
    private r: Rec,
    private sess: Session,
    maxConnections: () => number,
    private on: JobEvents,
  ) {
    this.limit = maxConnections();
  }

  async run(): Promise<void> {
    const r = this.r;
    try {
      const part = r.path + PART_EXT;
      await mkdir(dirname(r.path), { recursive: true });
      if (r.segments && existsSync(part)) {
        // Continuing: the file on the server must be unchanged, or the saved bytes are worthless.
        const probe = await probeRanges(this.sess, r);
        if (!probe) throw new Error('The server is unreachable or no longer allows resuming.');
        const same = probe.total === r.total &&
          (!r.etag || !probe.etag || probe.etag === r.etag) &&
          (!r.lastModified || !probe.lastModified || probe.lastModified === r.lastModified);
        if (!same) {
          r.segments = undefined; // changed on the server → start over
          r.total = probe.total;
          r.etag = probe.etag;
          r.lastModified = probe.lastModified;
        }
      }
      if (this.stopped) return;
      if (!r.segments || !existsSync(part)) {
        this.fh = await open(part, 'w+');
        await this.fh.truncate(r.total);
        r.segments = split(r.total, Math.min(this.limit, Math.ceil(r.total / MIN_SEGMENT)));
      } else {
        this.fh = await open(part, 'r+');
        if ((await stat(part)).size !== r.total) await this.fh.truncate(r.total);
      }
      if (this.stopped) return void this.closeFile();
      r.received = sum(r.segments);
      r.status = 'downloading';
      this.speedTimer = setInterval(() => this.tickSpeed(), 1000);
      this.fill();
      this.on.progress();
    } catch (e) {
      // Usually the network (offline at startup) — keep trying in the background.
      this.fail(errText(e));
    }
  }

  pause(): void {
    this.stop();
    this.r.status = 'paused';
  }

  /** Quit: stop quietly; the record stays "downloading" so it resumes next launch. */
  stopForExit(): void {
    this.stop();
  }

  cancel(): void {
    this.stop();
    this.r.status = 'cancelled';
    this.r.segments = undefined;
    void Promise.allSettled([...this.writes])
      .then(() => this.closeFile())
      .then(() => rm(this.r.path + PART_EXT, { force: true }))
      .catch(() => {});
  }

  // --- scheduling ---------------------------------------------------------------

  /** Keep up to `limit` connections busy; when idle, split the biggest running segment. */
  private fill(): void {
    if (this.stopped || !this.r.segments) return;
    const segs = this.r.segments;
    if (segs.every((s) => remaining(s) === 0)) return void this.finishIfDone();

    const now = Date.now();
    let wakeAt = Infinity;
    for (const s of segs) {
      if (this.active.size >= this.limit) break;
      if (remaining(s) === 0 || this.active.has(s)) continue;
      const until = this.cooldown.get(s) ?? 0;
      if (until > now) {
        wakeAt = Math.min(wakeAt, until);
        continue;
      }
      this.fetch(s);
    }
    // Work stealing: give idle connections half of the biggest remaining range.
    while (this.active.size < this.limit && this.fails === 0) {
      const left = (s: Segment) => remaining(s) - (this.inflight.get(s) ?? 0);
      const biggest = [...this.active.keys()].sort((a, b) => left(b) - left(a))[0];
      if (!biggest || left(biggest) < 2 * MIN_SEGMENT) break;
      const from = biggest.start + biggest.done + (this.inflight.get(biggest) ?? 0);
      const mid = from + Math.floor(left(biggest) / 2);
      const stolen: Segment = { start: mid, end: biggest.end, done: 0 };
      biggest.end = mid - 1; // its running request stops at the new end
      segs.push(stolen);
      this.fetch(stolen);
    }
    this.r.connections = this.active.size;

    if (wakeAt !== Infinity && !this.wakeTimer) {
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.fill();
      }, Math.max(50, wakeAt - now));
    }
  }

  private fetch(seg: Segment): void {
    const r = this.r;
    const req = net.request({ url: r.url, session: this.sess, useSessionCookies: true, redirect: 'follow' });
    req.setHeader('Range', `bytes=${seg.start + seg.done}-${seg.end}`);
    if (r.referrer) {
      try {
        req.setHeader('Referer', r.referrer);
      } catch {
        /* not settable on this request — fine */
      }
    }
    const entry = { req, timer: null as NodeJS.Timeout | null };
    this.active.set(seg, entry);
    this.inflight.set(seg, 0);
    const inflight = () => this.inflight.get(seg) ?? 0;
    const arm = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => endSeg(new Error('Connection stalled')), STALL_MS);
    };

    let ended = false;
    const endSeg = (err?: Error) => {
      if (ended) return;
      ended = true;
      if (entry.timer) clearTimeout(entry.timer);
      this.active.delete(seg);
      try {
        req.abort();
      } catch {
        /* already finished */
      }
      if (this.stopped) return;
      // Decide once this segment's pending writes have landed.
      void Promise.allSettled([...this.writes]).then(() => {
        if (this.stopped) return;
        if (err && remaining(seg) > 0) this.segmentFailed(seg, err);
        this.fill();
      });
    };

    req.on('response', (res: IncomingMessage) => {
      if (res.statusCode !== 206) {
        if (res.statusCode === 429 || res.statusCode === 503) this.limit = Math.max(1, this.active.size - 1);
        return endSeg(new Error(`Server answered ${res.statusCode} to a range request`));
      }
      arm();
      res.on('data', (chunk: Buffer) => {
        if (ended || this.stopped || !this.fh) return;
        arm();
        const pos = seg.start + seg.done + inflight();
        const room = seg.end - pos + 1; // seg.end can shrink when another connection steals work
        if (room <= 0) return endSeg();
        const buf = chunk.length > room ? chunk.subarray(0, room) : chunk;
        this.inflight.set(seg, inflight() + buf.length);
        const w = this.fh.write(buf, 0, buf.length, pos).then(
          () => {
            this.inflight.set(seg, inflight() - buf.length);
            seg.done += buf.length;
            this.speedBytes += buf.length;
            if (this.fails) {
              this.fails = 0;
              this.r.error = undefined;
            }
            this.r.received = sum(this.r.segments ?? []);
            this.on.saved();
            this.on.progress();
            if (inflight() < 4 << 20) flow(res).resume();
          },
          (e) => endSeg(e instanceof Error ? e : new Error(String(e))),
        );
        this.writes.add(w);
        void w.finally(() => this.writes.delete(w));
        if (inflight() >= 4 << 20) flow(res).pause(); // disk slower than the network: back off
        if (pos + buf.length > seg.end) endSeg(); // this range is complete
      });
      res.on('end', () => endSeg(seg.start + seg.done + inflight() <= seg.end ? new Error('Connection closed early') : undefined));
      res.on('error', (e: Error) => endSeg(e));
    });
    req.on('error', (e) => endSeg(e));
    req.end();
  }

  /** One segment failed: it waits (1 s, 2 s, 4 s … 30 s) while the others carry on. */
  private segmentFailed(seg: Segment, err: Error): void {
    this.fails++;
    this.r.retries++;
    this.r.error = err.message;
    if (this.fails >= MAX_FAILS) return this.fail(`${err.message} — retrying every minute.`);
    this.cooldown.set(seg, Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.fails - 1, 5)));
    this.on.progress();
  }

  private async finishIfDone(): Promise<void> {
    if (this.finishing || this.active.size || this.writes.size || !this.r.segments) return;
    if (this.r.segments.some((s) => remaining(s) > 0)) return;
    this.finishing = true;
    this.stopped = true;
    this.clearTimers();
    await this.closeFile();
    const r = this.r;
    try {
      if (existsSync(r.path)) {
        r.path = uniquePath(r.path);
        r.filename = basename(r.path);
      }
      await rename(r.path + PART_EXT, r.path);
      r.status = 'completed';
      r.error = undefined;
      r.received = r.total;
      r.segments = undefined;
    } catch (e) {
      r.status = 'failed';
      r.error = `Downloaded, but couldn’t rename it: ${errText(e)}`;
    }
    r.finished = Date.now();
    r.speed = 0;
    r.connections = 0;
    this.on.finished();
  }

  /** Give up for now: the manager marks it interrupted and retries in the background. */
  private fail(message: string): void {
    this.stop();
    this.r.status = 'interrupted';
    this.r.error = message;
    this.on.failedForNow();
  }

  private stop(): void {
    this.stopped = true;
    this.clearTimers();
    for (const { req, timer } of this.active.values()) {
      if (timer) clearTimeout(timer);
      try {
        req.abort();
      } catch {
        /* gone */
      }
    }
    this.active.clear();
    this.r.connections = 0;
    this.r.speed = 0;
    void Promise.allSettled([...this.writes]).then(() => this.closeFile());
    this.on.saved();
  }

  private clearTimers(): void {
    if (this.speedTimer) clearInterval(this.speedTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.speedTimer = null;
    this.wakeTimer = null;
  }

  private async closeFile(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    await fh?.close().catch(() => {});
  }

  private tickSpeed(): void {
    const now = Date.now();
    const inst = (this.speedBytes * 1000) / Math.max(1, now - this.speedAt);
    this.r.speed = this.r.speed ? this.r.speed * 0.6 + inst * 0.4 : inst;
    this.speedBytes = 0;
    this.speedAt = now;
    this.r.connections = this.active.size;
    this.on.progress();
  }
}

// --- pure helpers -------------------------------------------------------------------

/** Electron's IncomingMessage is a Node Readable at runtime; its typings just omit pause/resume. */
const flow = (res: IncomingMessage) => res as unknown as NodeJS.ReadableStream;

/** Ask for byte 0 only: does the server do ranges, and how big / which version is the file? */
function probeRanges(sess: Session, r: Pick<Rec, 'url' | 'referrer'>): Promise<{ total: number; etag?: string; lastModified?: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { total: number; etag?: string; lastModified?: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req.abort();
      } catch {
        /* finished */
      }
      resolve(v);
    };
    const req = net.request({ url: r.url, session: sess, useSessionCookies: true, redirect: 'follow' });
    const timer = setTimeout(() => done(null), 15_000);
    req.setHeader('Range', 'bytes=0-0');
    if (r.referrer) {
      try {
        req.setHeader('Referer', r.referrer);
      } catch {
        /* ignore */
      }
    }
    req.on('response', (res) => {
      const header = (name: string) => {
        const v = res.headers[name];
        return Array.isArray(v) ? v[0] : v;
      };
      const m = /\/(\d+)\s*$/.exec(header('content-range') ?? '');
      if (res.statusCode !== 206 || !m) return done(null);
      done({ total: Number(m[1]), etag: header('etag'), lastModified: header('last-modified') });
    });
    req.on('error', () => done(null));
    req.end();
  });
}

function split(total: number, n: number): Segment[] {
  const parts = Math.max(1, n);
  const size = Math.ceil(total / parts);
  const out: Segment[] = [];
  for (let start = 0; start < total; start += size) out.push({ start, end: Math.min(total, start + size) - 1, done: 0 });
  return out;
}

const remaining = (s: Segment) => Math.max(0, s.end - s.start + 1 - s.done);
const sum = (segs: Segment[]) => segs.reduce((a, s) => a + Math.min(s.done, s.end - s.start + 1), 0);
const isActive = (r: Rec) => r.status === 'downloading' || r.status === 'interrupted';
/** Not finished yet: running, waiting in the queue, paused or retrying. */
const isLive = (r: Rec) => isActive(r) || r.status === 'queued' || r.status === 'paused';
/** Queue order: priority, then who asked first. */
const byQueue = (a: Rec, b: Rec) => RANK[a.priority] - RANK[b.priority] || (a.queuedAt ?? a.started) - (b.queuedAt ?? b.started);

/** A torrent's name as a file/folder name (names come from strangers on the internet). */
function safeName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 200);
  return clean || 'Torrent';
}

/** "file.zip" → "file (1).zip" … until nothing (incl. a partial download) is in the way. */
function uniquePath(p: string): string {
  const taken = (x: string) => existsSync(x) || existsSync(x + PART_EXT) || existsSync(x + BROWSER_PART_EXT);
  if (!taken(p)) return p;
  const { dir, name, ext } = parse(p);
  for (let i = 1; ; i++) {
    const next = join(dir, `${name} (${i})${ext}`);
    if (!taken(next)) return next;
  }
}

function publicInfo(r: Rec): DownloadInfo {
  const out: Partial<DownloadInfo> = {};
  for (const k of PUBLIC_KEYS) (out as Record<string, unknown>)[k] = r[k];
  return out as DownloadInfo;
}

function safeUrl(u: string | undefined): string | undefined {
  return u && /^https?:/i.test(u) ? u : undefined;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
