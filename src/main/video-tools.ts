import { app, net } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { Event, type VideoToolsState } from '../shared/ipc-contract';

/** ffmpeg-static's builds. That release publishes no checksums, so the hashes are pinned here. */
const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/';
const FFMPEG_BUILDS: Record<string, { file: string; sha256: string }> = {
  win32: { file: 'ffmpeg-win32-x64.gz', sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77' },
  'darwin-x64': { file: 'ffmpeg-darwin-x64.gz', sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106' },
  'darwin-arm64': { file: 'ffmpeg-darwin-arm64.gz', sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa' },
};
/** yt-dlp follows the sites as they change, so it is always the latest release, checked against its SHA2-256SUMS. */
const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const YTDLP_ASSET: Record<string, string> = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos' };

const exe = process.platform === 'win32' ? '.exe' : '';

/**
 * The two programs behind "Save for offline", fetched once into
 * userData/tools on first use (~50 MB):
 *  - yt-dlp finds the real video on 1000s of sites (YouTube, Vimeo, course
 *    platforms…) and downloads any stream format (HLS, DASH, plain files);
 *  - ffmpeg joins video + audio and converts anything a browser can't play.
 * Downloads go through Chromium's network stack (net.fetch), like the rest of Bro.
 */
export class VideoTools {
  readonly dir = join(app.getPath('userData'), 'tools');
  readonly ffmpeg = join(this.dir, `ffmpeg${exe}`);
  readonly ytdlp = join(this.dir, `yt-dlp${exe}`);
  private installing: Promise<void> | null = null;
  private state: VideoToolsState = { ready: false, installing: false, progress: 0 };

  constructor(private emit: (channel: string, payload: unknown) => void) {
    this.state.ready = this.present();
    void readFile(join(this.dir, 'yt-dlp.version'), 'utf8')
      .then((v) => this.set({ ytdlpVersion: v.trim() }))
      .catch(() => {});
  }

  /** Both tools are on disk and not being replaced right now. */
  get ready(): boolean {
    return !this.installing && this.present();
  }

  get supported(): boolean {
    return !!YTDLP_ASSET[process.platform] && !!ffmpegBuild();
  }

  getState(): VideoToolsState {
    return { ...this.state };
  }

  private present(): boolean {
    return existsSync(this.ffmpeg) && existsSync(this.ytdlp);
  }

  /** Make sure both tools are there, fetching them if needed. */
  async ensure(): Promise<void> {
    if (this.present() && !this.installing) return;
    await this.install();
  }

  /** Fetch both tools (ffmpeg only if missing; yt-dlp always, so this doubles as "update"). */
  install(): Promise<void> {
    if (this.installing) return this.installing;
    this.installing = this.doInstall().finally(() => (this.installing = null));
    return this.installing;
  }

  private async doInstall(): Promise<void> {
    if (!this.supported) throw new Error(`Saving videos isn't available on ${process.platform}-${process.arch} yet.`);
    this.set({ installing: true, progress: 0, error: undefined });
    try {
      await mkdir(this.dir, { recursive: true });
      const build = ffmpegBuild()!;
      const asset = YTDLP_ASSET[process.platform];
      const needFfmpeg = !existsSync(this.ffmpeg);
      // Rough sizes, for the progress bar only.
      const plan = (needFfmpeg ? 30e6 : 0) + 18e6;
      let got = 0;
      const tick = (n: number) => {
        got += n;
        this.set({ progress: Math.min(0.99, got / plan) });
      };

      // yt-dlp: the checksum list first, then the program.
      const sums = await (await fetchOk(YTDLP_RELEASE + 'SHA2-256SUMS')).text();
      const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === asset)?.[0];
      if (!want) throw new Error('Could not read the yt-dlp checksum list.');
      const ytTmp = this.ytdlp + '.download';
      const ytHash = await fetchTo(YTDLP_RELEASE + asset, ytTmp, tick);
      if (ytHash !== want) {
        await rm(ytTmp, { force: true });
        throw new Error('yt-dlp download was corrupted (checksum mismatch) — try again.');
      }

      if (needFfmpeg) {
        const gzTmp = join(this.dir, build.file);
        const hash = await fetchTo(FFMPEG_RELEASE + build.file, gzTmp, tick);
        if (hash !== build.sha256) {
          await rm(gzTmp, { force: true });
          throw new Error('ffmpeg download was corrupted (checksum mismatch) — try again.');
        }
        const bin = await promisify(gunzip)(await readFile(gzTmp));
        await writeFile(this.ffmpeg + '.download', bin);
        await rm(gzTmp, { force: true });
        await rename(this.ffmpeg + '.download', this.ffmpeg);
        if (process.platform !== 'win32') await chmod(this.ffmpeg, 0o755);
      }

      await rm(this.ytdlp, { force: true });
      await rename(ytTmp, this.ytdlp);
      if (process.platform !== 'win32') await chmod(this.ytdlp, 0o755);
      const version = (await this.capture(this.ytdlp, ['--version'])).trim();
      await writeFile(join(this.dir, 'yt-dlp.version'), version);
      this.set({ ready: true, installing: false, progress: 1, ytdlpVersion: version });
    } catch (e) {
      this.set({ ready: this.present(), installing: false, progress: 0, error: errText(e) });
      throw e;
    }
  }

  /**
   * Start yt-dlp with Bro's defaults: no user config, Bro's ffmpeg, and Bro's
   * own Electron binary as the JavaScript runtime YouTube needs.
   */
  ytdlpProcess(args: string[]): ChildProcess {
    const base = [
      '--ignore-config',
      '--no-colors',
      '--ffmpeg-location', this.ffmpeg,
      '--js-runtimes', `node:${process.execPath}`,
      '--cache-dir', join(this.dir, 'cache'),
    ];
    return spawn(this.ytdlp, [...base, ...args], {
      windowsHide: true,
      // ELECTRON_RUN_AS_NODE makes process.execPath behave as plain Node for yt-dlp's JS challenges.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
  }

  ffmpegProcess(args: string[]): ChildProcess {
    return spawn(this.ffmpeg, ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
  }

  /** Run a tool to completion and return stdout + stderr. */
  capture(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn(file, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', reject);
      p.on('close', () => resolve(out));
    });
  }

  private set(patch: Partial<VideoToolsState>): void {
    this.state = { ...this.state, ...patch };
    this.emit(Event.VideoToolsChanged, this.getState());
  }
}

/** Stop a tool and everything it started (yt-dlp runs ffmpeg as a child). */
export function killTree(p: ChildProcess): void {
  if (p.exitCode !== null || p.pid == null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }).on('error', () => p.kill());
  } else {
    p.kill('SIGTERM');
  }
}

function ffmpegBuild(): { file: string; sha256: string } | undefined {
  // Windows on ARM runs the x64 build under emulation.
  return process.platform === 'win32' ? FFMPEG_BUILDS.win32 : FFMPEG_BUILDS[`${process.platform}-${process.arch}`];
}

async function fetchOk(url: string): Promise<Response> {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${url.split('/').pop()} (HTTP ${res.status}).`);
  return res;
}

/** Stream a URL to a file; returns its SHA-256. */
async function fetchTo(url: string, dest: string, onBytes: (n: number) => void): Promise<string> {
  const res = await fetchOk(url);
  if (!res.body) throw new Error(`Empty response from ${url}`);
  const hash = createHash('sha256');
  const fh = await open(dest, 'w');
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await fh.write(value);
      onBytes(value.length);
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
