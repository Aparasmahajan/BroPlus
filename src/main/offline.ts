import { app, shell, type OnResponseStartedListenerDetails, type Session, type WebContents } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsonStore } from './store';
import { killTree, type VideoTools } from './video-tools';
import { grabFile, grabHls, removeStreamDirs, type GrabContext } from './stream-grabber';
import { Event, type OfflineAction, type OfflineItem, type OfflineWhat, type Prefs } from '../shared/ipc-contract';

const EMIT_MS = 400;
const KEEP = 300;
const AUTO_RETRIES = 6; // network failures retried in the background before giving up
const RETRY_MS = 60_000;
const MAX_MEDIA = 30; // streams remembered per page
const MIN_FILE = 300_000; // smaller "videos" are previews, ads and sounds
const PAGE_FILE = 'page.mhtml';
const VIEWER_FILE = 'index.html';
const MEDIA_EXT = ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.3gp', '.ts', '.ogv', '.m4a', '.mp3', '.ogg', '.opus', '.oga', '.wav', '.flac', '.aac'];
const PLAYABLE_EXT = ['.mp4', '.m4v', '.webm', '.m4a', '.mp3', '.ogg', '.oga', '.ogv', '.opus', '.wav', '.flac'];
const PLAYABLE_VIDEO = ['h264', 'vp8', 'vp9', 'av1', 'theora'];
const PLAYABLE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_f32le'];
/** Codecs that can go into an .mp4 untouched (a quick remux instead of re-encoding). */
const MP4_VIDEO = ['h264', 'vp9', 'av1'];
const MP4_AUDIO = ['aac', 'mp3', 'opus', 'flac'];
const QUALITY = [360, 480, 720, 1080, 0, -1];
/** yt-dlp's catch-alls for sites it doesn't know: their titles are just "<page title> (1)". */
const GENERIC_EXTRACTORS = ['Generic', 'HTML5MediaEmbed'];
/** A plain page embedding more videos than this is a listing, not "the video on this page". */
const MAX_PAGE_VIDEOS = 20;
/** yt-dlp silent this long (no progress, no messages) is treated as stuck. */
const STALL_YTDLP_MS = 4 * 60_000;
/** yt-dlp's per-format pieces before joining: "name.f137.mp4", "name.fhls-720p.mp4". */
const FORMAT_PIECE = /\.f(\d[\w-]*|(hls|dash|http)-[\w.=-]+)\.\w+$/;

/** A video or stream seen while the page loaded. */
interface Media {
  url: string;
  kind: 'hls' | 'dash' | 'file';
  size: number;
}

/** The page's <video>/<audio> elements when Save was pressed (only explains a failed save). */
interface PageProbe {
  media: number;
  /** Played from a blob: URL — a streaming player (Media Source Extensions). */
  streamed: number;
  /** Has EME keys attached (mediaKeys): the player is set up for DRM — not proof every stream is encrypted. */
  encrypted: number;
}

interface Rec extends OfflineItem {
  partition: string;
  quality: number;
  subtitles: boolean;
  /** Streams seen on the page — tried when yt-dlp doesn't know the site itself. */
  media: Media[];
  /** The exact video that was right-clicked, tried first. */
  mediaUrl?: string;
  page?: PageProbe;
  userAgent?: string;
  /** Use the OS certificate store (networks that inspect TLS). */
  systemCerts?: boolean;
  autoRetries: number;
  resumeOnStart?: boolean;
  note?: string;
}

interface Ctx {
  private: boolean;
  profileId: string;
  partition: string;
}

const PUBLIC_KEYS: (keyof OfflineItem)[] = [
  'id', 'title', 'pageUrl', 'what', 'folder', 'status', 'stage', 'received', 'total', 'speed', 'eta',
  'videos', 'error', 'started', 'finished', 'private', 'profileId',
];

/** 'many': a single save turned out to be a whole course/playlist and was stopped. */
type Outcome = 'ok' | 'none' | 'drm' | 'network' | 'live' | 'stopped' | 'error' | 'many';

/** The save running now: its process (yt-dlp/ffmpeg) and in-flight browser requests, for Pause/Cancel. */
interface Job {
  id: string;
  proc: ChildProcess | null;
  stopped: boolean;
  aborts: (() => void)[];
}

const NO_VIDEO = 'No video Bro can save was found here. Press play on the video, wait a few seconds, then save again.';
const DRM = 'This video is DRM-protected (copy-protected), so Bro can’t save it. If the service offers downloads, use its own app to watch offline.';
const EME = 'This page plays its video with copy protection (DRM), and Bro found no unprotected copy to save. If the service offers downloads, use its own app to watch offline.';
const STREAMED = 'The player streams this video in pieces Bro doesn’t recognise (no video file or HLS/DASH playlist was seen), so there is nothing it can save.';
/** BRO_DEBUG_MEDIA=1: log what the sniffer sees and decides (addresses without their query, which can hold tokens). */
const DEBUG_MEDIA = !!process.env.BRO_DEBUG_MEDIA;
/** What download tools hear from bot walls and expired links. */
const BLOCKED = /HTTP Error 40[13]|\b40[13]\b|Forbidden|Unauthorized|cloudflare|captcha|confirm you.re not a bot|Sign in to confirm/i;

/**
 * "Save for offline": a page snapshot (MHTML, opens without internet) plus
 * every video on it, in its own folder with an index.html player
 * (subtitles, speed, resume position, lesson list for playlists).
 *
 * Videos: yt-dlp knows 1000s of sites and handles any stream format; when it
 * doesn't know a site, the streams Bro saw the page play (HLS/DASH manifests,
 * video files) are tried instead, with the tab's cookies. Whatever comes out
 * is converted to MP4 if Chromium couldn't play it. One save runs at a time
 * (slow connections), each can pause/resume, and network failures retry in
 * the background — yt-dlp continues partial files.
 */
export class OfflineManager {
  private readonly store = new JsonStore<Rec[]>('offline', []);
  private readonly recs = new Map<string, Rec>();
  /** webContents id → streams seen on its current page. */
  private readonly found = new Map<number, Media[]>();
  /** Save id → its page probe, taken when Save was pressed. */
  private readonly probes = new Map<string, Promise<PageProbe | null>>();
  private readonly sessions = new Map<string, Session>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running: Job | null = null;
  private emitTimer: NodeJS.Timeout | null = null;

  /** A page started/stopped having video: the toolbar button follows. */
  onMediaChanged: (wcId: number) => void = () => {};

  constructor(
    private emit: (channel: string, payload: unknown) => void,
    private prefs: () => Prefs,
    private tools: VideoTools,
    private resolveSession: (partition: string) => Session,
    private openTab: (url: string) => void,
  ) {
    for (const r of this.store.get()) {
      if (r.status === 'working' || r.status === 'queued' || r.status === 'interrupted') {
        r.status = 'paused';
        r.resumeOnStart = true;
        r.stage = 'Continues when Bro is back online…';
      }
      r.speed = 0;
      this.recs.set(r.id, r);
    }
  }

  // --- Finding videos on pages ------------------------------------------------

  /** Watch a session's responses for videos and streams (call once per session). */
  attach(sess: Session, partition: string): void {
    this.sessions.set(partition, sess);
    sess.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (d) => this.sniff(d));
  }

  /** Forget a tab's streams when it goes to another page. */
  track(wc: WebContents): void {
    const id = wc.id;
    const reset = () => {
      if (this.found.delete(id)) this.onMediaChanged(id);
    };
    wc.on('did-navigate', reset);
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (isMainFrame) reset();
    });
    wc.once('destroyed', () => this.found.delete(id));
  }

  hasVideo(wc: WebContents): boolean {
    return this.found.has(wc.id);
  }

  private sniff(d: OnResponseStartedListenerDetails): void {
    const wcId = d.webContentsId;
    if (wcId == null || d.statusCode >= 400) return;
    const kind = mediaKind(d.url, header(d.responseHeaders, 'content-type'));
    if (DEBUG_MEDIA) debugResponse(d, kind);
    if (!kind) return;
    const range = /\/(\d+)\s*$/.exec(header(d.responseHeaders, 'content-range') ?? '');
    const size = range ? Number(range[1]) : Number(header(d.responseHeaders, 'content-length') ?? -1);
    if (kind === 'file' && size >= 0 && size < MIN_FILE) return;

    const isNew = !this.found.has(wcId);
    const list = this.found.get(wcId) ?? [];
    this.found.set(wcId, list);
    // YouTube's player streams in pieces only yt-dlp can reassemble — remember that
    // the page has video, but the pieces themselves are no use.
    if (!/(^|\.)googlevideo\.com$/i.test(hostOf(d.url))) {
      const key = kind === 'file' ? stripQuery(d.url) : d.url;
      const known = list.find((m) => (m.kind === 'file' ? stripQuery(m.url) : m.url) === key);
      if (known) known.size = Math.max(known.size, size);
      else if (list.length < MAX_MEDIA) list.push({ url: d.url, kind, size });
    }
    if (isNew) this.onMediaChanged(wcId);
  }

  // --- Saving -------------------------------------------------------------------

  list(): OfflineItem[] {
    return [...this.recs.values()].sort((a, b) => b.started - a.started).map(publicInfo);
  }

  /** Save what's in this tab. The page snapshot is taken right away (the tab may move on). */
  save(wc: WebContents, ctx: Ctx, what: OfflineWhat, mediaUrl?: string): void {
    const pageUrl = wc.getURL();
    if (!/^https?:/i.test(pageUrl)) return;
    const prefs = this.prefs();
    const title = wc.getTitle() || hostOf(pageUrl) || 'Saved page';
    const r: Rec = {
      id: randomBytes(6).toString('hex'),
      title,
      pageUrl,
      what,
      folder: uniqueFolder(join(this.baseDir(), 'Bro Offline', safeName(title))),
      status: 'queued',
      stage: 'Waiting…',
      received: 0,
      total: -1,
      speed: 0,
      eta: -1,
      videos: 0,
      started: Date.now(),
      private: ctx.private,
      profileId: ctx.profileId,
      partition: ctx.partition,
      quality: QUALITY.includes(prefs.videoQuality) ? prefs.videoQuality : 720,
      subtitles: prefs.videoSubtitles,
      media: [...(this.found.get(wc.id) ?? [])].sort(byUsefulness),
      mediaUrl: mediaUrl && /^https?:/i.test(mediaUrl) ? mediaUrl : undefined,
      userAgent: wc.getUserAgent(),
      autoRetries: 0,
    };
    // Nothing played on the page and the video tools aren't here yet: don't
    // fetch 50 MB of tools to find out there's no video — keep the page.
    if (what === 'page+video' && !r.media.length && !r.mediaUrl && !this.tools.ready) {
      r.what = 'page';
      r.note = 'No video was playing on this page, so only the page was saved. Press play, then save again to get the video.';
    }
    this.recs.set(r.id, r);
    if (r.what !== 'page') this.probes.set(r.id, probePage(wc).then((p) => (p && (r.page = p), p)));
    this.changed(true);
    if (r.what !== 'video' && r.what !== 'playlist') void this.snapshot(r, wc);
    else this.pump();
  }

  private async snapshot(r: Rec, wc: WebContents): Promise<void> {
    r.status = 'working';
    r.stage = 'Saving the page…';
    this.changed(true);
    try {
      await mkdir(r.folder, { recursive: true });
      await wc.savePage(join(r.folder, PAGE_FILE), 'MHTML');
    } catch (e) {
      r.note = `The page itself couldn't be saved (${errText(e)}).`;
    }
    if (r.what === 'page') {
      await this.finish(r);
    } else {
      r.status = 'queued';
      r.stage = 'Waiting…';
      this.changed(true);
      this.pump();
    }
  }

  command(id: string, action: OfflineAction): void {
    const r = this.recs.get(id);
    if (!r) return;
    switch (action) {
      case 'open': {
        const target = this.entryFile(r);
        if (target) this.openTab(pathToFileURL(target).href);
        else void shell.openPath(r.folder);
        break;
      }
      case 'show':
        if (existsSync(r.folder)) void shell.openPath(r.folder);
        break;
      case 'pause':
        if (r.status === 'working' || r.status === 'queued' || r.status === 'interrupted') {
          this.stop(r);
          r.status = 'paused';
          r.stage = 'Paused';
        }
        break;
      case 'resume':
      case 'retry':
        if (r.status === 'completed') break;
        this.cancelTimer(r.id);
        r.status = 'queued';
        r.stage = 'Waiting…';
        r.error = undefined;
        r.autoRetries = 0;
        this.pump();
        break;
      case 'cancel':
        if (r.status !== 'completed') {
          this.stop(r);
          r.status = 'cancelled';
          r.stage = 'Cancelled';
          void removePartials(r.folder);
          void removeStreamDirs(r.folder);
        }
        break;
      case 'remove':
        this.stop(r);
        this.recs.delete(id);
        break;
      case 'delete':
        this.stop(r);
        this.recs.delete(id);
        // Give a stopped download a moment to let go of its files (Windows locks open files).
        setTimeout(() => void rm(r.folder, { recursive: true, force: true }).catch(() => {}), this.running?.id === id ? 2000 : 0);
        break;
    }
    this.changed(true);
  }

  /** Drop finished/failed/cancelled entries from the list (files stay). */
  clear(): void {
    for (const [id, r] of this.recs) {
      if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') this.recs.delete(id);
    }
    this.changed(true);
  }

  /** After startup: continue saves that were running when Bro closed. */
  init(): void {
    for (const r of this.recs.values()) {
      if (!r.resumeOnStart) continue;
      r.resumeOnStart = false;
      r.status = 'queued';
      r.stage = 'Waiting…';
    }
    setTimeout(() => this.pump(), 3000);
  }

  flush(): void {
    if (this.running) {
      const r = this.recs.get(this.running.id);
      if (r) r.resumeOnStart = true;
      this.stopRunning();
    }
    for (const r of this.recs.values()) if (r.status === 'queued' || r.status === 'interrupted') r.resumeOnStart = true;
    this.persist();
    this.store.flush();
  }

  // --- The queue ------------------------------------------------------------------

  /** One save at a time: a slow connection does better with one thing at full speed. */
  private pump(): void {
    if (this.running) return;
    const next = [...this.recs.values()].filter((r) => r.status === 'queued').sort((a, b) => a.started - b.started)[0];
    if (!next) return;
    this.running = { id: next.id, proc: null, stopped: false, aborts: [] };
    void this.run(next).finally(() => {
      this.running = null;
      this.changed(true);
      this.pump();
    });
  }

  private async run(r: Rec): Promise<void> {
    const job = this.running!;
    r.status = 'working';
    r.error = undefined;
    r.speed = 0;
    this.changed(true);
    try {
      await mkdir(r.folder, { recursive: true });
      // A page-only save that was cut short (Bro closed while saving): the tab is gone, nothing to fetch.
      if (r.what === 'page') {
        if (existsSync(join(r.folder, PAGE_FILE))) return await this.finish(r);
        return this.fail(r, 'Bro closed before the page was saved — open the page and save it again.');
      }
      if (!this.tools.ready) {
        r.stage = 'Getting the video tools (one time, about 50 MB)…';
        this.changed(true);
        const progress = setInterval(() => {
          r.received = Math.round(this.tools.getState().progress * 50e6);
          r.total = 50e6;
          this.changed();
        }, 500);
        try {
          await this.tools.ensure();
        } finally {
          clearInterval(progress);
          r.received = 0;
          r.total = -1;
        }
      }
      if (job.stopped) return;

      const outcome = await this.fetchVideos(r, job);
      if (job.stopped || outcome === 'stopped') return;

      if (outcome === 'network') return this.interrupted(r);
      if (outcome !== 'ok') {
        const why = r.error ?? NO_VIDEO;
        if (r.what === 'page+video' && existsSync(join(r.folder, PAGE_FILE))) r.note = `Only the page was saved. ${why}`;
        else return this.fail(r, why);
      }
      await this.convertAll(r, job);
      if (job.stopped) return;
      await this.finish(r);
    } catch (e) {
      if (job.stopped) return;
      if (looksOffline(errText(e))) return this.interrupted(r, errText(e));
      this.fail(r, errText(e));
    }
  }

  /**
   * Try, in order: the right-clicked video (through the browser), yt-dlp on the page
   * (it knows 1000s of sites), then the streams the page played — fetched through the
   * tab's own browser session, which works where sites block download tools.
   */
  private async fetchVideos(r: Rec, job: Job): Promise<Outcome> {
    const cookies = await this.cookieFile(r);
    try {
      type Target = { url: string; how: 'browser'; kind: 'hls' | 'file' } | { url: string; how: 'ytdlp'; page: boolean };
      const targets: Target[] = [];
      if (r.mediaUrl) targets.push({ url: r.mediaUrl, how: 'browser', kind: /\.m3u8(\?|$)/i.test(r.mediaUrl) ? 'hls' : 'file' });
      if (r.what !== 'video' || !r.mediaUrl) targets.push({ url: r.pageUrl, how: 'ytdlp', page: true });
      // A playlist/course only makes sense from the page itself.
      if (r.what !== 'playlist') {
        for (const m of r.media.slice(0, 4)) {
          if (m.url === r.mediaUrl) continue;
          targets.push(m.kind === 'dash' ? { url: m.url, how: 'ytdlp', page: false } : { url: m.url, how: 'browser', kind: m.kind });
        }
      }

      const seen: Outcome[] = [];
      const errors: string[] = [];
      for (const t of targets) {
        if (job.stopped) return 'stopped';
        r.error = undefined;
        const out = t.how === 'browser' ? await this.browserGrab(r, t.url, t.kind, job) : await this.ytdlpTries(r, t.url, t.page, cookies);
        if (out === 'ok' || out === 'stopped') return out;
        seen.push(out);
        if (r.error) errors.push(r.error);
      }
      if (seen.includes('network')) return 'network';
      await this.probes.get(r.id);
      this.probes.delete(r.id);
      r.error = explain(r, seen, errors);
      return seen.every((s) => s === 'none') ? 'none' : 'error';
    } finally {
      if (cookies) await rm(cookies, { force: true }).catch(() => {});
    }
  }

  /** yt-dlp, again with the OS certificate store or posing as Chrome if the first try is refused. */
  private async ytdlpTries(r: Rec, url: string, isPage: boolean, cookies: string | null): Promise<Outcome> {
    let out = await this.ytdlp(r, url, isPage, cookies);
    if (out === 'error' && !r.systemCerts && /CERTIFICATE_VERIFY_FAILED/i.test(r.error ?? '')) {
      r.systemCerts = true; // TLS-inspecting network: trust what Windows/macOS trusts
      out = await this.ytdlp(r, url, isPage, cookies);
    }
    // Bot walls (Cloudflare & co.) often let a request through that looks like Chrome down to its TLS handshake.
    let impersonate = false;
    if (out === 'error' && BLOCKED.test(r.error ?? '')) out = await this.ytdlp(r, url, isPage, cookies, (impersonate = true));
    // "Save this video" on a page yt-dlp sees as a whole course/playlist (a Udemy lecture opens
    // as its course): take only the entry this page is about, else the stream the page plays.
    if (out === 'many') {
      // List the entries without opening each one (one request even for a 534-lecture course),
      // then download only the entry whose id is in the page address.
      r.stage = 'This page belongs to a course — finding just this lesson…';
      this.changed(true);
      const entry = await this.findEntry(r, url, cookies, impersonate);
      out = entry ? await this.ytdlp(r, entry, true, cookies, impersonate, true) : 'none';
      if (out !== 'ok' && out !== 'stopped' && out !== 'network' && out !== 'drm') {
        out = 'none';
        r.error = undefined;
      }
    }
    return out;
  }

  /** The playlist entry whose id appears in the page address (udemy …/lecture/45349019 → that lecture). */
  private findEntry(r: Rec, url: string, cookies: string | null, impersonate: boolean): Promise<string | null> {
    const ids = idTokens(r.pageUrl);
    if (!ids.length) return Promise.resolve(null);
    const args = ['--flat-playlist', '--no-warnings', '--print', 'BROENTRY %(id)s %(url,webpage_url)s'];
    if (cookies) args.push('--cookies', cookies);
    if (r.userAgent) args.push('--user-agent', r.userAgent);
    if (r.systemCerts) args.push('--compat-options', 'no-certifi');
    if (impersonate) args.push('--impersonate', 'chrome');
    args.push('--', url);
    return new Promise((resolve) => {
      const p = this.tools.ytdlpProcess(args);
      if (this.running) this.running.proc = p;
      let found: string | null = null;
      let buf = '';
      p.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) {
          const m = /^BROENTRY (\S+) (\S+)/.exec(l.trim());
          if (m && !found && ids.includes(m[1]) && /^https?:/i.test(m[2])) {
            found = m[2];
            killTree(p); // got it — no need to list the rest
          }
        }
      });
      // Listing a course is one quick request; don't let a stuck one hold up the queue.
      const timer = setTimeout(() => killTree(p), 120_000);
      p.on('error', () => resolve(null));
      p.on('close', () => {
        clearTimeout(timer);
        resolve(found);
      });
    });
  }

  /** Fetch a stream the page played through the tab's own session (cookies, user agent). */
  private async browserGrab(r: Rec, url: string, kind: 'hls' | 'file', job: Job): Promise<Outcome> {
    let lastBytes = 0;
    let lastAt = Date.now();
    const ctx: GrabContext = {
      sess: this.sessionFor(r),
      referer: r.pageUrl,
      folder: r.folder,
      name: safeName(r.title),
      quality: r.quality,
      connections: this.prefs().downloadConnections || 4,
      stopped: () => job.stopped,
      onAbort: (fn) => job.aborts.push(fn),
      progress: (received, total) => {
        const now = Date.now();
        if (now - lastAt >= 1000) {
          const inst = Math.max(0, ((received - lastBytes) * 1000) / (now - lastAt));
          r.speed = r.speed ? r.speed * 0.6 + inst * 0.4 : inst;
          lastBytes = received;
          lastAt = now;
        }
        r.received = received;
        r.total = total;
        r.eta = total > 0 && r.speed > 0 ? (total - received) / r.speed : -1;
        this.changed();
      },
      stage: (text) => {
        r.stage = text;
        this.changed(true);
      },
      ffmpeg: (args) => this.runFfmpeg(args),
    };
    const res = kind === 'hls' ? await grabHls(ctx, url) : await grabFile(ctx, url);
    r.speed = 0;
    if (res.outcome === 'ok') {
      r.videos = Math.max(r.videos, 1);
      return 'ok';
    }
    r.error = res.error;
    if (res.outcome === 'drm' || res.outcome === 'network' || res.outcome === 'stopped' || res.outcome === 'live') return res.outcome;
    return 'error';
  }

  /** `entry`: url is one entry picked out of a course/playlist (never treat it as the whole list). */
  private async ytdlp(r: Rec, url: string, isPage: boolean, cookies: string | null, impersonate = false, entry = false): Promise<Outcome> {
    const audioOnly = r.quality === -1;
    const name = r.what === 'playlist'
      ? '%(playlist_index|0)03d - %(title).120B [%(id)s].%(ext)s'
      : isPage ? '%(title).120B [%(id)s].%(ext)s' : `${safeName(r.title)}.%(ext)s`;
    const args = [
      '--newline', '--progress', '--no-mtime', '--ignore-errors',
      '--progress-template', 'download:BROPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
      // BROSEEN comes before anything of the video is written — early enough to stop a whole course.
      '--print', 'after_filter:BROSEEN %(n_entries|0)s %(extractor_key)s',
      '--print', 'before_dl:BROINFO %(playlist_index|0)s %(n_entries|0)s %(extractor_key)s\t%(playlist_title|)s\t%(title)s',
      '--print', 'after_move:BRODONE %(filepath)s',
      '--retries', '20', '--fragment-retries', '20',
      '-N', String(Math.min(4, Math.max(1, this.prefs().downloadConnections || 4))),
      '-P', r.folder, '-o', name,
      r.what === 'playlist' ? '--yes-playlist' : '--no-playlist',
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--write-description',
      // Only the videos' own thumbnails/descriptions, not the playlist's (they belong to no video).
      '--no-write-playlist-metafiles',
    ];
    if (audioOnly) args.push('-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a');
    else args.push('-S', r.quality > 0 ? `res:${r.quality},vcodec:h264,acodec:aac` : 'vcodec:h264,acodec:aac', '--merge-output-format', 'mp4');
    if (r.subtitles) args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en,en-US,en-GB,en-orig', '--convert-subs', 'vtt');
    if (cookies) args.push('--cookies', cookies);
    if (r.userAgent) args.push('--user-agent', r.userAgent);
    if (!isPage) args.push('--add-header', `Referer:${r.pageUrl}`);
    if (r.systemCerts) args.push('--compat-options', 'no-certifi');
    if (impersonate) args.push('--impersonate', 'chrome');
    // A stream address is just a stream: don't let a site extractor mistake it for a page
    // (udemy.com/assets/… would otherwise be fetched as a Udemy course).
    if (!isPage) args.push('--use-extractors', 'generic');
    args.push('--', url);

    r.stage = entry ? 'Downloading just this lesson…' : isPage ? 'Looking for the video…' : 'Downloading the stream the page played…';
    this.changed(true);
    // What was in the folder before, so a run stopped for being a whole course leaves nothing behind.
    const before = new Set(await readdir(r.folder).catch(() => [] as string[]));
    // One "Save video" may still fetch several videos from a page that embeds a few (generic pages).
    const single = isPage && !entry && r.what !== 'playlist';

    return new Promise((resolve) => {
      const job = this.running;
      const p = this.tools.ytdlpProcess(args);
      if (job) job.proc = p;
      const errors: string[] = [];
      let saved = 0;
      let buf = '';
      let tooMany = false;
      // Watchdog: a run that shows no sign of life for this long is stuck (a site answering
      // very slowly, an endless listing) — stop it so the next way in, and the queue, can go on.
      let lastSign = Date.now();
      let stalled = false;
      const watchdog = setInterval(() => {
        if (Date.now() - lastSign < STALL_YTDLP_MS) return;
        stalled = true;
        clearInterval(watchdog);
        killTree(p);
      }, 10_000);
      p.stdout?.on('data', () => (lastSign = Date.now()));
      p.stderr?.on('data', () => (lastSign = Date.now()));
      const onLine = (line: string) => {
        if (line.startsWith('BROSEEN ')) {
          const [n, extractor] = line.slice(8).split(' ');
          const count = Number(n) || 0;
          if (single && count > 1 && (!GENERIC_EXTRACTORS.includes(extractor) || count > MAX_PAGE_VIDEOS)) {
            tooMany = true;
            killTree(p);
          }
        } else if (tooMany) {
          // Stopping: ignore the rest.
        } else if (line.startsWith('BROPROG ')) {
          const [d, t, te, s, e] = line.slice(8).split(' ').map(Number);
          r.received = d || 0;
          r.total = t || te || -1;
          r.speed = s || 0;
          r.eta = Number.isFinite(e) ? e : -1;
          this.changed();
        } else if (line.startsWith('BROINFO ')) {
          const m = /^BROINFO (\S+) (\S+) (\S+)\t(.*?)\t(.*)$/.exec(line);
          const i = Number(m?.[1]) || 0;
          const n = Number(m?.[2]) || 0;
          const t = m?.[5] ?? '';
          r.stage = n > 1 && r.what === 'playlist' ? `Video ${i} of ${n}: ${t}` : `Downloading: ${t}`;
          // A site yt-dlp knows names things better than the tab did (YouTube's title
          // still says just "YouTube" while the page loads).
          if (isPage && m && !GENERIC_EXTRACTORS.includes(m[3])) {
            const better = r.what === 'playlist' ? m[4] : t;
            if (better && better !== 'NA') r.title = better;
          }
          r.received = 0;
          r.total = -1;
          this.changed(true);
        } else if (line.startsWith('BRODONE ')) {
          if (MEDIA_EXT.includes(extname(line.slice(8)).toLowerCase())) {
            saved++;
            r.videos = Math.max(r.videos, saved);
          }
          this.changed(true);
        } else if (/^\[(Merger|VideoConvertor|ExtractAudio|FixupM3u8|FixupM4a|VideoRemuxer)\]/.test(line)) {
          r.stage = audioOnly ? 'Preparing the audio…' : 'Joining video and audio…';
          r.speed = 0;
          this.changed();
        }
      };
      const feed = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) onLine(l.trim());
      };
      p.stdout?.on('data', feed);
      p.stderr?.on('data', (chunk: Buffer) => {
        for (const l of chunk.toString('utf8').split(/\r?\n/)) {
          if (/^ERROR:/.test(l)) errors.push(l.replace(/^ERROR:\s*/, '').trim());
        }
      });
      p.on('error', (e) => errors.push(errText(e)));
      p.on('close', () => {
        clearInterval(watchdog);
        if (buf) onLine(buf.trim());
        r.speed = 0;
        if (job?.stopped) return resolve('stopped');
        // Nothing saved and nothing to resume: leave the folder as this run found it.
        const tidy = async (out: Outcome) => {
          for (const n of await readdir(r.folder).catch(() => [] as string[])) {
            if (!before.has(n)) await rm(join(r.folder, n), { recursive: true, force: true }).catch(() => {});
          }
          resolve(out);
        };
        if (tooMany) return void tidy('many');
        if (stalled && saved === 0) {
          r.error = 'The site took too long to answer.';
          return void tidy('error');
        }
        const all = errors.join('\n');
        // Subtitle hiccups are only warnings; a video that arrived is a success.
        if (saved > 0) return resolve('ok');
        r.error = errors.at(-1);
        // Partial files stay for the retry after a network drop.
        if (looksOffline(all)) return resolve('network');
        if (/DRM/i.test(all)) return void tidy('drm');
        if (/Unsupported URL|No video formats|Unable to extract|no suitable|no video|Requested format is not available/i.test(all) || !all) return void tidy('none');
        void tidy('error');
      });
    });
  }

  /** The tab's cookies for the page and stream hosts (so signed-in course videos work). */
  private async cookieFile(r: Rec): Promise<string | null> {
    try {
      const sess = this.sessionFor(r);
      const domains = new Set([r.pageUrl, r.mediaUrl, ...r.media.map((m) => m.url)].filter(Boolean).map((u) => baseDomain(hostOf(u!))));
      const all = await sess.cookies.get({});
      const lines = ['# Netscape HTTP Cookie File'];
      for (const c of all) {
        const d = (c.domain ?? '').replace(/^\./, '');
        if (![...domains].some((b) => d === b || d.endsWith(`.${b}`))) continue;
        const domain = (c.httpOnly ? '#HttpOnly_' : '') + (c.hostOnly ? d : `.${d}`);
        lines.push([domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path ?? '/', c.secure ? 'TRUE' : 'FALSE', Math.round(c.expirationDate ?? 0), c.name, c.value].join('\t'));
      }
      if (lines.length === 1) return null;
      const file = join(app.getPath('temp'), `bro-cookies-${randomBytes(8).toString('hex')}.txt`);
      await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
      return file;
    } catch {
      return null;
    }
  }

  // --- Making sure it plays -------------------------------------------------------

  /** Anything Chromium can't play becomes an MP4 (a remux when the codecs allow, else a re-encode). */
  private async convertAll(r: Rec, job: { stopped: boolean }): Promise<void> {
    for (const file of await mediaFiles(r.folder)) {
      if (job.stopped) return;
      const path = join(r.folder, file);
      const info = await this.probe(path);
      const ext = extname(file).toLowerCase();
      const videoOk = !info.video || PLAYABLE_VIDEO.includes(info.video);
      const audioOk = !info.audio || PLAYABLE_AUDIO.includes(info.audio);
      if (videoOk && audioOk && PLAYABLE_EXT.includes(ext)) continue;

      const copy = (!info.video || MP4_VIDEO.includes(info.video)) && (!info.audio || MP4_AUDIO.includes(info.audio));
      const out = uniqueFile(join(r.folder, `${parse(file).name}${info.video ? '.mp4' : '.m4a'}`));
      const args = ['-y', '-i', path, '-map', '0:v:0?', '-map', '0:a:0?', '-movflags', '+faststart'];
      if (copy) args.push('-c', 'copy');
      else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k');
      args.push(out);

      r.stage = copy ? `Making ${file} playable…` : `Converting ${file} to MP4 (this can take a while)…`;
      r.received = 0;
      r.total = -1;
      this.changed(true);
      const ok = await this.runFfmpeg(args, (seconds) => {
        if (info.duration <= 0) return;
        r.received = Math.min(1000, Math.round((seconds / info.duration) * 1000));
        r.total = 1000;
        this.changed();
      });
      if (job.stopped) return void rm(out, { force: true }).catch(() => {});
      if (ok) await rm(path, { force: true });
      else await rm(out, { force: true });
    }
  }

  /** Run ffmpeg as the current job's process (so Pause/Cancel stop it); true on success. */
  private runFfmpeg(args: string[], onTime?: (seconds: number) => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const withProgress = onTime ? ['-progress', 'pipe:1', '-nostats', ...args] : args;
      const p = this.tools.ffmpegProcess(withProgress);
      if (this.running) this.running.proc = p;
      p.stdout?.on('data', (d: Buffer) => {
        const m = /out_time_us=(\d+)/.exec(d.toString());
        if (m && onTime) onTime(Number(m[1]) / 1e6);
      });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }

  private sessionFor(r: Rec): Session {
    return this.sessions.get(r.partition) ?? this.resolveSession(r.partition);
  }

  private async probe(file: string): Promise<{ video?: string; audio?: string; duration: number }> {
    const out = await this.tools.capture(this.tools.ffmpeg, ['-hide_banner', '-i', file]);
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
    return {
      video: /Stream #[^\n]*?: Video: (\w+)/.exec(out)?.[1]?.toLowerCase(),
      audio: /Stream #[^\n]*?: Audio: (\w+)/.exec(out)?.[1]?.toLowerCase(),
      duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    };
  }

  // --- Finishing --------------------------------------------------------------------

  private async finish(r: Rec): Promise<void> {
    this.probes.delete(r.id);
    try {
      const videos = await mediaFiles(r.folder);
      r.videos = videos.length;
      if (videos.length) await writeFile(join(r.folder, VIEWER_FILE), await viewerHtml(r, videos));
      r.status = 'completed';
      r.stage = r.note ?? (videos.length ? `${videos.length} video${videos.length === 1 ? '' : 's'} saved` : 'Page saved');
      r.error = undefined;
    } catch (e) {
      r.status = 'failed';
      r.error = `Saved, but couldn’t write the player page: ${errText(e)}`;
    }
    r.finished = Date.now();
    r.speed = 0;
    r.received = 0;
    r.total = -1;
    r.eta = -1;
    this.changed(true);
  }

  private fail(r: Rec, message: string): void {
    r.status = 'failed';
    r.error = message;
    r.stage = 'Failed';
    r.finished = Date.now();
    r.speed = 0;
    this.changed(true);
  }

  /** Lost the connection: try again in a minute (yt-dlp continues the partial files). */
  private interrupted(r: Rec, message?: string): void {
    r.status = 'interrupted';
    r.speed = 0;
    if (message) r.error = message;
    if (r.autoRetries >= AUTO_RETRIES) {
      r.stage = 'Stopped after several tries — press Resume when you’re online.';
      this.changed(true);
      return;
    }
    r.autoRetries++;
    r.stage = `No connection — trying again in a minute (try ${r.autoRetries} of ${AUTO_RETRIES}).`;
    this.cancelTimer(r.id);
    this.timers.set(
      r.id,
      setTimeout(() => {
        this.timers.delete(r.id);
        if (r.status !== 'interrupted') return;
        r.status = 'queued';
        this.pump();
      }, RETRY_MS),
    );
    this.changed(true);
  }

  private stop(r: Rec): void {
    this.cancelTimer(r.id);
    if (this.running?.id === r.id) this.stopRunning();
    r.speed = 0;
  }

  private stopRunning(): void {
    if (!this.running) return;
    this.running.stopped = true;
    if (this.running.proc) killTree(this.running.proc);
    for (const abort of this.running.aborts) abort();
  }

  private cancelTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  /** What "Open" shows: the player page, else the saved page. */
  private entryFile(r: Rec): string | null {
    for (const f of [VIEWER_FILE, PAGE_FILE]) if (existsSync(join(r.folder, f))) return join(r.folder, f);
    return null;
  }

  private baseDir(): string {
    const d = this.prefs().downloadDir;
    return d && existsSync(d) ? d : app.getPath('downloads');
  }

  private changed(now = false): void {
    this.persist();
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emit(Event.OfflineChanged, this.list());
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit(Event.OfflineChanged, this.list());
    }, EMIT_MS);
  }

  private persist(): void {
    // Saves from private tabs keep their files but aren't listed after a restart.
    const keep = [...this.recs.values()].filter((r) => !r.private).sort((a, b) => b.started - a.started).slice(0, KEEP);
    this.store.set(keep.map((r) => ({ ...r, media: r.media.map((m) => ({ ...m })) })));
  }
}

// --- The player page --------------------------------------------------------------

/**
 * index.html in the save folder: plays every saved video with its subtitles,
 * remembers where you stopped, has speed buttons and a lesson list. Fully
 * self-contained, so it works from any browser with no internet. Subtitles are
 * inlined because browsers refuse <track> files from file:// pages.
 */
async function viewerHtml(r: Rec, videos: string[]): Promise<string> {
  const names = await readdir(r.folder);
  const items = [];
  for (const file of videos) {
    const base = parse(file).name;
    const poster = names.find((n) => n.startsWith(base) && /\.(jpe?g|png|webp)$/i.test(n));
    const subs = [];
    for (const n of names.filter((x) => x.startsWith(base) && x.toLowerCase().endsWith('.vtt'))) {
      const lang = n.slice(base.length).replace(/\.vtt$/i, '').replace(/^\./, '') || 'en';
      subs.push({ lang, text: await readFile(join(r.folder, n), 'utf8').catch(() => '') });
    }
    const descFile = names.find((n) => n === `${base}.description`);
    const description = descFile ? await readFile(join(r.folder, descFile), 'utf8').catch(() => '') : '';
    const audio = /\.(m4a|mp3|ogg|oga|opus|wav|flac|aac)$/i.test(file);
    items.push({ file, title: base.replace(/\s*\[[\w-]+\]$/, '').replace(/^0*(\d+) - /, '$1. '), poster, subs, description, audio });
  }
  const hasPage = names.includes(PAGE_FILE);
  const data = JSON.stringify({ items, key: r.id }).replace(/</g, '\\u003c');
  const saved = new Date(r.started).toLocaleString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)}</title>
<style>
:root { --bg:#f6f7f9; --fg:#1d2026; --muted:#5f6672; --card:#fff; --line:#e3e6eb; --accent:#4f46e5; }
@media (prefers-color-scheme: dark) { :root { --bg:#15171b; --fg:#e8eaee; --muted:#9aa1ad; --card:#1e2127; --line:#2d313a; --accent:#8b85ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:20px 24px 8px; max-width:1200px; margin:0 auto; }
h1 { font-size:20px; margin:0 0 4px; }
.meta { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
.meta a { color:var(--accent); }
main { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:20px; padding:12px 24px 32px; max-width:1200px; margin:0 auto; }
main.single { grid-template-columns:minmax(0,1fr); }
video, audio { width:100%; background:#000; border-radius:10px; display:block; }
video { max-height:calc(100vh - 190px); object-fit:contain; }
audio { background:none; margin-top:12px; }
.controls { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:10px 0; }
.controls span { color:var(--muted); font-size:13px; margin-right:4px; }
button { font:inherit; font-size:13px; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px; padding:4px 10px; cursor:pointer; }
button.on { border-color:var(--accent); color:var(--accent); font-weight:600; }
h2 { font-size:17px; margin:14px 0 6px; }
.desc { white-space:pre-wrap; color:var(--muted); font-size:14px; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; max-height:320px; overflow:auto; }
.list { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:auto; max-height:calc(100vh - 140px); }
.list button { display:flex; gap:8px; width:100%; text-align:left; border:0; border-bottom:1px solid var(--line); border-radius:0; padding:10px 12px; background:none; }
.list button.on { background:color-mix(in srgb, var(--accent) 12%, transparent); }
.list .done { color:#16a34a; min-width:1em; }
@media (max-width: 800px) { main { grid-template-columns:minmax(0,1fr); padding:12px 16px; } header { padding:16px 16px 4px; } }
</style>
</head>
<body>
<header>
  <h1>${esc(r.title)}</h1>
  <div class="meta">Saved ${esc(saved)} from <a href="${esc(r.pageUrl)}">${esc(r.pageUrl)}</a>${hasPage ? ` · <a href="${PAGE_FILE}">Open the saved web page</a>` : ''}</div>
</header>
<main id="main">
  <section>
    <div id="player"></div>
    <div class="controls" id="speeds"><span>Speed</span></div>
    <h2 id="now"></h2>
    <div id="desc" class="desc" hidden></div>
  </section>
  <aside id="side"><div class="list" id="list"></div></aside>
</main>
<script type="application/json" id="data">${data}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var items = data.items, current = -1, media = null;
  var store = { get: function (k) { try { return localStorage.getItem('bro:' + data.key + ':' + k); } catch (e) { return null; } },
                set: function (k, v) { try { localStorage.setItem('bro:' + data.key + ':' + k, v); } catch (e) {} } };
  var speed = Number(store.get('speed')) || 1;
  if (items.length < 2) { document.getElementById('main').classList.add('single'); document.getElementById('side').hidden = true; }

  [0.75, 1, 1.25, 1.5, 1.75, 2].forEach(function (s) {
    var b = document.createElement('button');
    b.textContent = s + '×';
    b.onclick = function () { speed = s; store.set('speed', s); if (media) media.playbackRate = s; mark(); };
    b.dataset.speed = s;
    document.getElementById('speeds').appendChild(b);
  });
  function mark() {
    document.querySelectorAll('#speeds button').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.speed) === speed); });
    document.querySelectorAll('#list button').forEach(function (b, i) {
      b.classList.toggle('on', i === current);
      b.querySelector('.done').textContent = store.get('done:' + i) ? '✓' : '';
    });
  }

  var list = document.getElementById('list');
  items.forEach(function (it, i) {
    var b = document.createElement('button');
    var d = document.createElement('span'); d.className = 'done';
    var t = document.createElement('span'); t.textContent = it.title;
    b.appendChild(d); b.appendChild(t);
    b.onclick = function () { play(i, true); };
    list.appendChild(b);
  });

  function play(i, autoplay) {
    if (media) store.set('pos:' + current, String(media.currentTime));
    current = i;
    store.set('last', String(i));
    var it = items[i];
    var el = document.createElement(it.audio ? 'audio' : 'video');
    el.controls = true;
    el.preload = 'metadata';
    el.src = encodeURI(it.file).replace(/#/g, '%23').replace(/\\?/g, '%3F');
    if (it.poster && !it.audio) el.poster = encodeURI(it.poster).replace(/#/g, '%23').replace(/\\?/g, '%3F');
    it.subs.forEach(function (s, k) {
      if (!s.text) return;
      var tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = s.lang;
      tr.srclang = s.lang.slice(0, 2);
      tr.src = URL.createObjectURL(new Blob([s.text], { type: 'text/vtt' }));
      if (k === 0) tr.default = true;
      el.appendChild(tr);
    });
    var pos = Number(store.get('pos:' + i)) || 0;
    el.addEventListener('loadedmetadata', function () { if (pos > 5 && pos < el.duration - 5) el.currentTime = pos; el.playbackRate = speed; });
    el.addEventListener('ratechange', function () { if (el.playbackRate !== speed) { speed = el.playbackRate; store.set('speed', speed); mark(); } });
    var saveAt = 0;
    el.addEventListener('timeupdate', function () { if (Date.now() - saveAt > 3000) { saveAt = Date.now(); store.set('pos:' + i, String(el.currentTime)); } });
    el.addEventListener('ended', function () { store.set('done:' + i, '1'); store.set('pos:' + i, '0'); mark(); if (i + 1 < items.length) play(i + 1, true); });
    var box = document.getElementById('player');
    box.replaceChildren(el);
    media = el;
    document.getElementById('now').textContent = it.title;
    var desc = document.getElementById('desc');
    desc.textContent = it.description || '';
    desc.hidden = !it.description;
    mark();
    if (autoplay) el.play().catch(function () {});
  }
  window.addEventListener('pagehide', function () { if (media) store.set('pos:' + current, String(media.currentTime)); });
  var last = Number(store.get('last'));
  play(last >= 0 && last < items.length ? last : 0, false);
})();
</script>
</body>
</html>
`;
}

// --- helpers -----------------------------------------------------------------------

function mediaKind(url: string, type: string | undefined): Media['kind'] | null {
  const t = (type ?? '').toLowerCase().split(';')[0].trim();
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (t.includes('mpegurl') || path.endsWith('.m3u8')) return 'hls';
  if (t === 'application/dash+xml' || path.endsWith('.mpd')) return 'dash';
  // Pieces of a stream, not whole videos.
  if (t === 'video/mp2t' || t === 'video/iso.segment' || /\.(ts|m4s|m4f|m4v_\d+|cmfv|cmfa)$/.test(path)) return null;
  if (t.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv|flv|avi|wmv|3gp|ogv)$/.test(path)) return 'file';
  return null;
}

/**
 * Manifests first (they carry every quality), in the order the player loaded them —
 * players load the master list before the one quality they play, and only the master
 * lets Bro pick the quality you chose. Then plain files, biggest first.
 */
function byUsefulness(a: Media, b: Media): number {
  const rank = (m: Media) => (m.kind === 'file' ? 1 : 0);
  return rank(a) - rank(b) || (a.kind === 'file' ? b.size - a.size : 0);
}

function header(h: Record<string, string[]> | undefined, name: string): string | undefined {
  if (!h) return undefined;
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k][0];
  return undefined;
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

function stripQuery(u: string): string {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
}

/** "videos.cdn.example.co.uk" → "example.co.uk" (close enough to pick cookies). */
function baseDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const n = parts.at(-1)!.length === 2 && parts.at(-2)!.length <= 3 ? 3 : 2;
  return parts.slice(-n).join('.');
}

/**
 * Pieces of the page address that could be a video id —
 * udemy.com/course/x/learn/lecture/45349009 → [course, x, learn, lecture, 45349009].
 */
function idTokens(pageUrl: string): string[] {
  try {
    const u = new URL(pageUrl);
    return [...new Set([...u.pathname.split('/'), ...u.searchParams.values()].filter((t) => /^[\w-]{4,}$/.test(t)))];
  } catch {
    return [];
  }
}

/** The most useful thing to tell the user when nothing could be saved. */
function explain(r: Rec, seen: Outcome[], errors: string[]): string {
  const all = errors.join('\n');
  const played = r.media.length > 0 || !!r.mediaUrl;
  if (seen.includes('live')) return 'This is a live stream — it can be saved once it has ended.';
  // Only when nothing else could be saved: a protected stream doesn't make the page's other videos protected.
  if (seen.includes('drm')) return DRM;
  if (!played && r.page?.encrypted) return EME;
  if (!played && r.page?.streamed) return STREAMED;
  if (r.what === 'playlist') {
    return `This site doesn’t let Bro save the whole course at once${all ? ` (${shortError(errors.at(-1) ?? '')})` : ''}. Open each lesson, press play, then press Ctrl+S — every lesson is saved on its own.`;
  }
  if (BLOCKED.test(all)) {
    return played
      ? 'The site refused the download, even through the browser. Reload the page, press play, wait a few seconds, then save again (links to videos expire). If you need to sign in to watch, sign in first.'
      : 'The site blocks download tools. Press play on the video, wait a few seconds, then save again — Bro will fetch the video the same way your browser plays it.';
  }
  if (/\b(404|410)\b/.test(all)) return 'The link to the video has expired. Reload the page, press play, then save again.';
  if (!played) return NO_VIDEO;
  return errors.length ? `The video couldn’t be saved: ${shortError(errors.at(-1)!)}` : NO_VIDEO;
}

/**
 * Read-only look at the media elements in every frame of the page: streaming player (blob: source)?
 * EME keys attached? Runs in the page's own world (where mediaKeys is visible); changes nothing.
 */
const PROBE_JS = `[...document.querySelectorAll('video, audio')].map((m) => ({ streamed: m.currentSrc.startsWith('blob:'), encrypted: m.mediaKeys != null }))`;

async function probePage(wc: WebContents): Promise<PageProbe | null> {
  try {
    const perFrame = await Promise.all(
      wc.mainFrame.framesInSubtree.map((f) =>
        Promise.race([
          f.executeJavaScript(PROBE_JS).catch(() => []) as Promise<{ streamed: boolean; encrypted: boolean }[]>,
          new Promise<[]>((r) => setTimeout(() => r([]), 2000)),
        ]),
      ),
    );
    const all = perFrame.flat();
    return { media: all.length, streamed: all.filter((m) => m.streamed).length, encrypted: all.filter((m) => m.encrypted).length };
  } catch {
    return null;
  }
}

/** BRO_DEBUG_MEDIA: one line per media-like response — what it was and what the sniffer made of it. */
function debugResponse(d: OnResponseStartedListenerDetails, kind: Media['kind'] | null): void {
  const type = header(d.responseHeaders, 'content-type') ?? '';
  if (!kind && !/^(video|audio)\/|octet-stream|mpegurl|dash|mp4/i.test(type)) return;
  const size = header(d.responseHeaders, 'content-range') ?? header(d.responseHeaders, 'content-length') ?? '?';
  console.log(`[bro media] tab ${d.webContentsId} ${d.statusCode} ${kind ?? 'ignored'} type=${type || '-'} size=${size} ${stripQuery(d.url)}`);
}

/** yt-dlp's errors carry a "[site] id:" prefix and a "(caused by …)" tail — keep the readable part. */
function shortError(e: string): string {
  return e.replace(/^\[[^\]]+\]\s*[^:]*:\s*/, '').replace(/\s*\(caused by .*$/i, '').slice(0, 160);
}

function looksOffline(text: string): boolean {
  return /getaddrinfo|Unable to connect|timed out|Connection (reset|refused|aborted)|Temporary failure|Network is unreachable|No route to host|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|IncompleteRead|Errno 1100[14]|urlopen error|HTTP Error 5\d\d/i.test(text);
}

async function mediaFiles(folder: string): Promise<string[]> {
  const names = await readdir(folder).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (!MEDIA_EXT.includes(extname(n).toLowerCase())) continue;
    // yt-dlp's leftovers: "name.f137.mp4" pieces waiting to be joined.
    if (FORMAT_PIECE.test(n)) continue;
    const s = await stat(join(folder, n)).catch(() => null);
    if (s?.isFile() && s.size > 0) out.push(n);
  }
  return out;
}

async function removePartials(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const n of names) {
    if (/\.(part|ytdl)$|\.part-Frag\d+/.test(n) || FORMAT_PIECE.test(n)) await rm(join(folder, n), { force: true }).catch(() => {});
  }
}

/** A file/folder name every OS accepts. */
function safeName(s: string): string {
  const clean = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) || !clean ? `Saved ${clean}`.trim() : clean;
}

function uniqueFolder(p: string): string {
  if (!existsSync(p)) return p;
  for (let i = 2; ; i++) if (!existsSync(`${p} (${i})`)) return `${p} (${i})`;
}

function uniqueFile(p: string): string {
  if (!existsSync(p)) return p;
  const { dir, name, ext } = parse(p);
  for (let i = 1; ; i++) {
    const next = join(dir, `${name} (${i})${ext}`);
    if (!existsSync(next)) return next;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function publicInfo(r: Rec): OfflineItem {
  const out: Partial<OfflineItem> = {};
  for (const k of PUBLIC_KEYS) (out as Record<string, unknown>)[k] = r[k];
  return out as OfflineItem;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
