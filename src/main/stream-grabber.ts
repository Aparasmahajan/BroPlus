import { net, type ClientRequest, type IncomingMessage, type Session } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/**
 * Downloads the stream a page is playing through Chromium's own network stack:
 * the tab's session, cookies and user agent, so the site sees the same browser
 * that is already allowed to play it. This is what works when a site blocks
 * download tools (Cloudflare, signed CDN links, "403 Forbidden").
 *
 *  - HLS (.m3u8): picks the variant for the chosen quality (plus its separate
 *    audio track), mirrors every segment, init section and AES-128 key into a
 *    local folder, then ffmpeg joins them into one file. Segments already on
 *    disk are kept, so a retry continues where it stopped.
 *  - Plain files: one connection, resumed with a Range request.
 *
 * DRM (Widevine/PlayReady/FairPlay/SAMPLE-AES) and live streams are refused: Bro only
 * saves video that isn't encrypted for a licensed player.
 */

export interface GrabContext {
  sess: Session;
  referer: string;
  folder: string;
  /** Output file name without extension. */
  name: string;
  /** Max height (360/480/720/1080), 0 = best, -1 = audio only. */
  quality: number;
  connections: number;
  stopped(): boolean;
  /** Called with a function that aborts every request in flight. */
  onAbort(fn: () => void): void;
  progress(received: number, total: number): void;
  stage(text: string): void;
  /** Run ffmpeg (killable by the caller); true on success. */
  ffmpeg(args: string[]): Promise<boolean>;
}

export type GrabOutcome = 'ok' | 'drm' | 'live' | 'network' | 'forbidden' | 'gone' | 'error' | 'stopped';
export interface GrabResult {
  outcome: GrabOutcome;
  error?: string;
  file?: string;
}

const STALL_MS = 30_000;
const TRIES = 6;
const STREAM_DIR = '.bro-stream-';

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${shortUrl(url)}`);
  }
}

// --- HLS ------------------------------------------------------------------------------

interface Variant {
  url: string;
  height: number;
  bandwidth: number;
  audio?: string; // GROUP-ID of its audio renditions
}

export async function grabHls(ctx: GrabContext, url: string): Promise<GrabResult> {
  try {
    ctx.stage('Reading the stream…');
    const text = await fetchText(ctx, url);
    if (!text.trimStart().startsWith('#EXTM3U')) return { outcome: 'error', error: 'That address is not a video stream.' };
    if (isDrm(text)) return { outcome: 'drm' };

    let videoUrl = url;
    let audioUrl: string | undefined;
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const { variants, audio } = parseMaster(text, url);
      if (!variants.length) return { outcome: 'error', error: 'The stream lists no videos.' };
      const v = pickVariant(variants, ctx.quality);
      videoUrl = v.url;
      const tracks = audio.filter((a) => a.group === v.audio);
      const track = tracks.find((a) => a.isDefault) ?? tracks.find((a) => /^en/i.test(a.lang)) ?? tracks[0];
      audioUrl = track?.url;
    }

    const dir = join(ctx.folder, STREAM_DIR + createHash('sha1').update(stripQuery(url)).digest('hex').slice(0, 10));
    await mkdir(dir, { recursive: true });
    const lists: { local: string; files: Fetch[] }[] = [];
    const onlyAudio = ctx.quality === -1 && !!audioUrl;
    if (!onlyAudio) lists.push(await mirrorPlaylist(ctx, videoUrl, dir, 'v'));
    if (audioUrl) lists.push(await mirrorPlaylist(ctx, audioUrl, dir, 'a'));

    const files = lists.flatMap((l) => l.files);
    ctx.stage(files.length > 1 ? `Downloading ${files.length} pieces of the video…` : 'Downloading…');
    await fetchAll(ctx, files);
    if (ctx.stopped()) return { outcome: 'stopped' };

    // Join the pieces into one playable file.
    ctx.stage(ctx.quality === -1 ? 'Preparing the audio…' : 'Joining the video together…');
    const audioOut = ctx.quality === -1;
    const out = uniqueFile(join(ctx.folder, `${ctx.name}${audioOut ? '.m4a' : '.mp4'}`));
    const input = (p: string) => ['-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data', '-i', p];
    const base = ['-y', ...lists.flatMap((l) => input(l.local))];
    const maps = audioOut
      ? ['-map', `${lists.length - 1}:a:0`, '-vn']
      : lists.length > 1
        ? ['-map', '0:v:0', '-map', '1:a:0']
        : ['-map', '0:v:0?', '-map', '0:a:0?'];
    let ok = await ctx.ffmpeg([...base, ...maps, '-c', 'copy', '-movflags', '+faststart', out]);
    if (!ok && !ctx.stopped()) {
      // Unusual codecs inside the stream: re-encode instead of copying.
      await rm(out, { force: true });
      ok = await ctx.ffmpeg([...base, ...maps, ...(audioOut ? [] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);
    }
    if (ctx.stopped()) {
      await rm(out, { force: true });
      return { outcome: 'stopped' };
    }
    if (!ok) {
      await rm(out, { force: true });
      return { outcome: 'error', error: 'The stream downloaded, but its pieces could not be joined.' };
    }
    await rm(dir, { recursive: true, force: true });
    return { outcome: 'ok', file: out };
  } catch (e) {
    return failure(e, ctx);
  }
}

/** Is any key in this playlist real DRM (not plain AES-128 HLS)? */
function isDrm(text: string): boolean {
  for (const m of text.matchAll(/#EXT-X-(?:SESSION-)?KEY:(.*)/gi)) {
    const a = attrs(m[1]);
    const method = (a.METHOD ?? '').toUpperCase();
    const format = (a.KEYFORMAT ?? 'identity').toLowerCase();
    if (method === 'NONE') continue;
    if (method !== 'AES-128' || format !== 'identity') return true;
  }
  return false;
}

function parseMaster(text: string, base: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: Variant[] = [];
  const audio: { group: string; url: string; isDefault: boolean; lang: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#EXT-X-STREAM-INF:/i.test(l)) {
      const a = attrs(l.slice(l.indexOf(':') + 1));
      const uri = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (!uri) continue;
      variants.push({
        url: new URL(uri, base).href,
        height: Number(/x(\d+)/i.exec(a.RESOLUTION ?? '')?.[1] ?? 0),
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] ?? a.BANDWIDTH ?? 0),
        audio: a.AUDIO,
      });
    } else if (/^#EXT-X-MEDIA:/i.test(l)) {
      const a = attrs(l.slice(l.indexOf(':') + 1));
      if ((a.TYPE ?? '').toUpperCase() === 'AUDIO' && a.URI) {
        audio.push({ group: a['GROUP-ID'] ?? '', url: new URL(a.URI, base).href, isDefault: a.DEFAULT === 'YES', lang: a.LANGUAGE ?? '' });
      }
    }
  }
  return { variants, audio };
}

/** The best variant not taller than the chosen quality (or the smallest, if they're all taller). */
function pickVariant(variants: Variant[], quality: number): Variant {
  const size = (v: Variant) => v.height * 1e9 + v.bandwidth;
  const sorted = [...variants].sort((a, b) => size(a) - size(b));
  if (quality === -1) return sorted[0];
  if (quality === 0) return sorted[sorted.length - 1];
  const fits = sorted.filter((v) => !v.height || v.height <= quality);
  return fits.length ? fits[fits.length - 1] : sorted[0];
}

interface Fetch {
  url: string;
  file: string;
  range?: [number, number]; // inclusive
}

/** Rewrite a media playlist to point at local copies; returns what has to be fetched. */
async function mirrorPlaylist(ctx: GrabContext, url: string, dir: string, tag: string): Promise<{ local: string; files: Fetch[] }> {
  const text = await fetchText(ctx, url);
  if (isDrm(text)) throw new DrmError();
  if (/#EXT-X-STREAM-INF/i.test(text)) throw new Error('Nested stream lists are not supported.');
  if (!/#EXT-X-ENDLIST/i.test(text) && !/#EXT-X-PLAYLIST-TYPE:VOD/i.test(text)) throw new LiveError();

  const files: Fetch[] = [];
  const out: string[] = [];
  const nextOffset = new Map<string, number>(); // byte-range segments continue where the last one ended
  let pendingRange: string | null = null;
  let n = 0;
  const local = (u: string, kind: string, range?: [number, number]) => {
    const name = `${tag}-${kind}${String(++n).padStart(5, '0')}${segExt(u)}`;
    files.push({ url: u, file: join(dir, name), range });
    return name;
  };
  const byteRange = (spec: string, u: string): [number, number] => {
    const [len, off] = spec.split('@').map(Number);
    const start = Number.isFinite(off) ? off : (nextOffset.get(u) ?? 0);
    nextOffset.set(u, start + len);
    return [start, start + len - 1];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXT-X-BYTERANGE:/i.test(line)) {
      pendingRange = line.slice(line.indexOf(':') + 1);
      continue; // the local copy is exactly that range
    }
    if (/^#EXT-X-(MAP|KEY):/i.test(line)) {
      const tagName = line.slice(0, line.indexOf(':'));
      const a = attrs(line.slice(line.indexOf(':') + 1));
      if (!a.URI) {
        out.push(line);
        continue;
      }
      const u = new URL(a.URI, url).href;
      const range = a.BYTERANGE ? byteRange(a.BYTERANGE, u) : undefined;
      const name = local(u, /MAP/i.test(tagName) ? 'init' : 'key', range);
      const rest = Object.entries(a)
        .filter(([k]) => k !== 'URI' && k !== 'BYTERANGE')
        .map(([k, v]) => `${k}=${QUOTED.has(k) ? `"${v}"` : v}`);
      out.push(`${tagName}:${[`URI="${name}"`, ...rest].join(',')}`);
      continue;
    }
    if (line.startsWith('#')) {
      out.push(line);
      continue;
    }
    const u = new URL(line, url).href;
    const range = pendingRange ? byteRange(pendingRange, u) : undefined;
    pendingRange = null;
    out.push(local(u, 'seg', range));
  }
  const localPath = join(dir, `${tag}.m3u8`);
  await writeFile(localPath, out.join('\n') + '\n');
  return { local: localPath, files };
}

const QUOTED = new Set(['KEYFORMAT', 'KEYFORMATVERSIONS', 'URI']);

/** Fetch every piece, a few at a time, skipping the ones already on disk. */
async function fetchAll(ctx: GrabContext, files: Fetch[]): Promise<void> {
  let doneBytes = 0;
  let doneCount = 0;
  const todo: Fetch[] = [];
  for (const f of files) {
    const s = await stat(f.file).catch(() => null);
    if (s?.isFile()) {
      doneBytes += s.size;
      doneCount++;
    } else todo.push(f);
  }
  let inflight = 0;
  const report = () => {
    const avg = doneCount ? doneBytes / doneCount : 0;
    ctx.progress(doneBytes + inflight, avg ? Math.round(avg * files.length) : -1);
  };
  report();
  const width = Math.max(1, Math.min(6, ctx.connections));
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (!failed && !ctx.stopped() && next < todo.length) {
      const f = todo[next++];
      let mine = 0; // bytes of the current attempt, dropped again if it fails
      try {
        const got = await withRetries(ctx, () => {
          inflight -= mine;
          mine = 0;
          return download(ctx, f.url, f.file, f.range, (n) => {
            mine += n;
            inflight += n;
            report();
          });
        });
        inflight -= mine;
        doneBytes += got;
        doneCount++;
        report();
      } catch (e) {
        failed = e;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (failed) throw failed;
}

// --- Plain files ----------------------------------------------------------------------

export async function grabFile(ctx: GrabContext, url: string): Promise<GrabResult> {
  try {
    const ext = /\.(mp4|m4v|webm|mov|mkv|flv|avi|wmv|3gp|ogv|m4a|mp3|ogg|opus)$/i.exec(new URL(url).pathname)?.[0] ?? '.mp4';
    const out = join(ctx.folder, `${ctx.name}${ext.toLowerCase()}`);
    if (existsSync(out)) return { outcome: 'ok', file: out };
    ctx.stage('Downloading the video the page plays…');
    const part = `${out}.part`;
    let total = -1;
    await withRetries(ctx, async () => {
      const have = (await stat(part).catch(() => null))?.size ?? 0;
      let got = have;
      try {
        await download(ctx, url, part, have ? [have, -1] : undefined, (n) => ctx.progress((got += n), total), {
          append: true,
          onStart: (t, from) => {
            total = t;
            got = from;
          },
        });
      } catch (e) {
        // Everything was already here: the server has nothing past the end.
        if (!(e instanceof HttpError && e.status === 416 && have > 0)) throw e;
      }
      return 0;
    });
    if (ctx.stopped()) return { outcome: 'stopped' };
    await rename(part, out);
    return { outcome: 'ok', file: out };
  } catch (e) {
    return failure(e, ctx);
  }
}

// --- Network ---------------------------------------------------------------------------

class DrmError extends Error {
  constructor() {
    super('DRM');
  }
}
class LiveError extends Error {
  constructor() {
    super('live');
  }
}

async function withRetries<T>(ctx: GrabContext, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < TRIES; i++) {
    if (ctx.stopped()) throw new Error('stopped');
    try {
      return await fn();
    } catch (e) {
      last = e;
      // Refusals don't get better by asking again (once more, in case of a hiccup).
      if (e instanceof HttpError && [401, 403, 404, 410].includes(e.status) && i >= 1) break;
      await new Promise((r) => setTimeout(r, Math.min(16_000, 1000 * 2 ** i)));
    }
  }
  throw last;
}

function request(ctx: GrabContext, url: string, range?: [number, number]): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, session: ctx.sess, useSessionCookies: true, redirect: 'follow' });
    for (const [k, v] of Object.entries({ Referer: ctx.referer, Origin: origin(ctx.referer) })) {
      try {
        if (v) req.setHeader(k, v);
      } catch {
        /* not settable here — fine */
      }
    }
    if (range) req.setHeader('Range', `bytes=${range[0]}-${range[1] >= 0 ? range[1] : ''}`);
    const live = liveRequests(ctx);
    live.add(req);
    const forget = () => live.delete(req);
    req.on('close', forget);
    req.on('abort', forget);
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('Connection timed out'));
    }, STALL_MS);
    req.on('response', (res) => {
      clearTimeout(timer);
      if (res.statusCode >= 400) {
        req.abort();
        return reject(new HttpError(res.statusCode, url));
      }
      resolve({ req, res });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

/** Requests in flight per save, so Pause/Cancel can abort them all at once. */
const inflightBySave = new WeakMap<GrabContext, Set<ClientRequest>>();
function liveRequests(ctx: GrabContext): Set<ClientRequest> {
  let set = inflightBySave.get(ctx);
  if (!set) {
    const s = new Set<ClientRequest>();
    inflightBySave.set(ctx, s);
    ctx.onAbort(() => {
      for (const r of s) {
        try {
          r.abort();
        } catch {
          /* done */
        }
      }
      s.clear();
    });
    set = s;
  }
  return set;
}

async function fetchText(ctx: GrabContext, url: string): Promise<string> {
  return withRetries(ctx, async () => {
    const { res } = await request(ctx, url);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    return Buffer.concat(chunks).toString('utf8');
  });
}

/**
 * Stream one URL to a file (via `.tmp`, so a half-written piece never counts as done).
 * `append` continues an existing file; returns the bytes written.
 */
async function download(
  ctx: GrabContext,
  url: string,
  file: string,
  range: [number, number] | undefined,
  onBytes: (n: number) => void,
  opts: { append?: boolean; onStart?: (total: number, from: number) => void } = {},
): Promise<number> {
  const append = !!opts.append;
  const { req, res } = await request(ctx, url, range);
  // Asked to continue but the server sent everything again: start over.
  const restart = !!(append && range && res.statusCode === 200);
  const from = append && range && !restart ? range[0] : 0;
  const len = Number(header(res, 'content-length') ?? -1);
  const all = /\/(\d+)\s*$/.exec(header(res, 'content-range') ?? '');
  opts.onStart?.(all ? Number(all[1]) : len > 0 ? len + from : -1, from);
  const target = append ? file : `${file}.tmp`;
  const fh = await open(target, append && !restart ? 'a' : 'w');
  let written = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let stall = setTimeout(() => fail(new Error('Connection stalled')), STALL_MS);
      const fail = (e: Error) => {
        clearTimeout(stall);
        try {
          req.abort();
        } catch {
          /* done */
        }
        reject(e);
      };
      const stream = res as unknown as NodeJS.ReadableStream;
      let chain = Promise.resolve();
      res.on('data', (c: Buffer) => {
        clearTimeout(stall);
        stall = setTimeout(() => fail(new Error('Connection stalled')), STALL_MS);
        if (ctx.stopped()) return fail(new Error('stopped'));
        stream.pause();
        chain = chain
          .then(() => fh.write(c))
          .then(() => {
            written += c.length;
            onBytes(c.length);
            stream.resume();
          }, fail);
      });
      res.on('end', () => {
        clearTimeout(stall);
        void chain.then(() => resolve());
      });
      res.on('error', (e: Error) => fail(e));
      req.on('abort', () => fail(new Error('stopped')));
    });
  } finally {
    await fh.close();
  }
  if (!append) await rename(target, file);
  return written;
}

// --- helpers -----------------------------------------------------------------------------

function failure(e: unknown, ctx: GrabContext): GrabResult {
  if (ctx.stopped()) return { outcome: 'stopped' };
  if (e instanceof DrmError) return { outcome: 'drm' };
  if (e instanceof LiveError) return { outcome: 'live', error: 'This is a live stream — it can be saved once it has ended.' };
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) return { outcome: 'forbidden', error: e.message };
    if (e.status === 404 || e.status === 410) return { outcome: 'gone', error: e.message };
    if (e.status >= 500) return { outcome: 'network', error: e.message };
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/ERR_|timed out|stalled|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(msg)) return { outcome: 'network', error: msg };
  return { outcome: 'error', error: msg };
}

/** KEY="value",OTHER=x → { KEY: 'value', OTHER: 'x' } */
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi)) out[m[1].toUpperCase()] = m[3] ?? m[2];
  return out;
}

function segExt(u: string): string {
  try {
    const e = extname(new URL(u).pathname).toLowerCase();
    return /^\.(ts|m4s|mp4|m4a|m4v|aac|mp3|vtt|key|bin|cmfv|cmfa)$/.test(e) ? e : '.bin';
  } catch {
    return '.bin';
  }
}

function header(res: IncomingMessage, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function origin(u: string): string | undefined {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
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

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.host + x.pathname.slice(0, 40);
  } catch {
    return u.slice(0, 60);
  }
}

function uniqueFile(p: string): string {
  if (!existsSync(p)) return p;
  const dot = p.lastIndexOf('.');
  for (let i = 1; ; i++) {
    const next = `${p.slice(0, dot)} (${i})${p.slice(dot)}`;
    if (!existsSync(next)) return next;
  }
}

/** Leftover stream folders (cancelled saves). */
export async function removeStreamDirs(folder: string): Promise<void> {
  for (const n of await readdir(folder).catch(() => [] as string[])) {
    if (n.startsWith(STREAM_DIR)) await rm(join(folder, n), { recursive: true, force: true }).catch(() => {});
  }
}
