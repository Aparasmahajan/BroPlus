// Start Bro Plus for the e2e suites, isolated from any real profile.
//
//   node tests/e2e/launch.mjs [configDir] [appDir]
//     Starts the app from `npm run build` output with the main inspector on :9229 and page
//     DevTools on :9333, and BRO_PLUS_CONFIG_DIR=<configDir> (a fresh temp folder if omitted),
//     so all state (profile, cookies, data/*.json, tools/) lives there. Ctrl+C quits it.
//
// As a module: `launch({ configDir, appDir })` → { proc, configDir, quit(), kill() }.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSPECT_PORT, CDP_PORT, MAIN_URL, CDP_URL, waitFor, connect, sleep } from './lib.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');

export const freshConfigDir = (tag = 'run') => mkdtempSync(join(tmpdir(), `bro-plus-e2e-${tag}-`));

const portBusy = async (url) => { try { await fetch(`${url}/json/version`); return true; } catch { return false; } };

/**
 * Launch the app. `appDir` is the folder holding package.json + dist/ (the repo by default;
 * run-all.mjs uses a copy for the browser-only build). Resolves once the window is visible.
 */
export async function launch({ configDir = freshConfigDir(), appDir = ROOT, env = {}, args = [], log } = {}) {
  if (await portBusy(MAIN_URL) || await portBusy(CDP_URL)) throw new Error(`port ${INSPECT_PORT} or ${CDP_PORT} is already in use — is another test instance still running?`);
  mkdirSync(configDir, { recursive: true });
  const out = openSync(log ?? join(configDir, 'app.log'), 'a');
  // A test window covered by other windows counts as "occluded" on Windows: its pages turn
  // hidden and synthetic mouse input (the real right-click check) is dropped. Keep it live.
  const live = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
  const proc = spawn(ELECTRON, [appDir, `--inspect=${INSPECT_PORT}`, `--remote-debugging-port=${CDP_PORT}`, ...live, ...args], {
    cwd: appDir,
    env: { ...process.env, BRO_PLUS_CONFIG_DIR: configDir, NO_PROXY: '*', no_proxy: '*', ...env },
    stdio: ['ignore', out, out],
    windowsHide: false,
  });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  // Startup on the dev machine is slow (15–35 s, more while another build runs).
  const list = await waitFor(async () => { if (exited) throw new Error('exited'); const l = await (await fetch(`${MAIN_URL}/json/list`)).json(); return l.length ? l : false; }, 300000, 500);
  if (!list) { kill(proc); throw new Error(`app did not open its inspector (log: ${join(configDir, 'app.log')})`); }
  const main = await connect(list[0].webSocketDebuggerUrl);
  const visible = await waitFor(() => main.evaluate(`(globalThis.__E = globalThis.__E || require('electron'), globalThis.__E.BrowserWindow.getAllWindows().some(w => w.isVisible()))`), 300000, 500);
  main.ws.close();
  if (!visible) { kill(proc); throw new Error('window never became visible'); }

  const waitExit = (ms) => new Promise((r) => { if (exited) return r(true); const t = setTimeout(() => r(false), ms); proc.once('exit', () => { clearTimeout(t); r(true); }); });
  return {
    proc,
    configDir,
    /**
     * Graceful quit: app.quit() runs the window 'close' autosave and 'will-quit' store
     * flushes. Node won't exit while an inspector client is attached, so every connection
     * must be closed first (a suite process that's still alive counts too). If it still
     * hasn't exited after `ms`, kill the tree; cookies are flushed first so that can't lose them.
     */
    async quit(ms = 30000) {
      if (exited) return;
      try {
        const l = await (await fetch(`${MAIN_URL}/json/list`)).json();
        const c = await connect(l[0].webSocketDebuggerUrl);
        await c.evaluate(`(async () => { const E = require('electron'); const ss = new Set([E.session.defaultSession, ...E.webContents.getAllWebContents().map(w => w.session)]); await Promise.all([...ss].map(s => s.cookies.flushStore().catch(() => {}))); setTimeout(() => E.app.quit(), 500); return true; })()`).catch(() => {});
        c.ws.close(); // an attached inspector client makes Node wait at exit ("Waiting for the debugger to disconnect")
      } catch {}
      await waitFor(async () => exited || !(await portBusy(MAIN_URL)), 60000, 300);
      if (!(await waitExit(ms))) { kill(proc); await waitExit(15000); }
      killStragglers(configDir);
      await waitFor(async () => !(await portBusy(MAIN_URL)) && !(await portBusy(CDP_URL)), 20000, 300);
      await sleep(1000);
    },
    /** Hard kill, like a crash or a power cut (no will-quit, no flush). */
    async kill() {
      kill(proc);
      await waitExit(15000);
      killStragglers(configDir);
      await waitFor(async () => !(await portBusy(MAIN_URL)) && !(await portBusy(CDP_URL)), 20000, 300);
      await sleep(1000); // let Chromium's helper processes release the profile lock
    },
  };
}

/**
 * Helper processes (GPU, network service) can outlive a main process that already exited —
 * then taskkill /T no longer reaches them and they keep the profile locked. Kill whatever
 * still runs with this config dir as its --user-data-dir.
 */
function killStragglers(configDir) {
  if (process.platform !== 'win32') return;
  const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:BRO_E2E_DIR) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { env: { ...process.env, BRO_E2E_DIR: configDir }, stdio: 'ignore' });
  } catch {}
}

function kill(proc) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch {}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , dir, appDir] = process.argv;
  const app = await launch({ configDir: dir ? resolve(dir) : undefined, appDir: appDir ? resolve(appDir) : ROOT });
  console.log(`Bro Plus is up (pid ${app.proc.pid}). Config dir: ${app.configDir}\nMain inspector :${INSPECT_PORT}, pages :${CDP_PORT}. Ctrl+C to quit.`);
  process.on('SIGINT', async () => { await app.quit(); process.exit(0); });
  app.proc.on('exit', () => process.exit(0));
}
