// Run the e2e suites against the `npm run build` output, each in a fresh app with its own
// throw-away config dir (BRO_PLUS_CONFIG_DIR), relaunching where a suite has phases.
//
//   node tests/e2e/run-all.mjs                     every suite (25–45 min on the slow dev machine)
//   node tests/e2e/run-all.mjs main profiles       just these
//   node tests/e2e/run-all.mjs offline --youtube   + the real-YouTube offline checks (needs internet)
//   --keep   keep the temp config dirs (their app.log helps when a suite fails)
//
// Suites: main private context-menu dead-tab stress library-tab profiles downloads offline plugin-seams
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, freshConfigDir, ROOT } from './launch.mjs';
import { makeOfflineMedia } from './fixtures/make-offline-media.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const YOUTUBE = argv.includes('--youtube');
const ALL = ['main', 'private', 'context-menu', 'dead-tab', 'stress', 'library-tab', 'profiles', 'downloads', 'offline', 'plugin-seams'];
const chosen = argv.filter((a) => !a.startsWith('--'));
for (const s of chosen) if (!ALL.includes(s)) throw new Error(`unknown suite "${s}" (one of: ${ALL.join(' ')})`);
const suites = chosen.length ? chosen : ALL;

if (!existsSync(join(ROOT, 'dist', 'main', 'index.js'))) throw new Error('no dist/ — run `npm run build` first');

const results = [];
const dirs = [];
const fresh = (tag) => { const d = freshConfigDir(tag); dirs.push(d); return d; };

/** Run a suite script with node; streams its output, returns { code, out }. */
function node(script, args = []) {
  console.log(`\n$ node tests/e2e/${script} ${args.join(' ')}`);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, script), ...args], { cwd: ROOT, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } });
    let out = '';
    const take = (d) => { out += d; process.stdout.write(d); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (code) => resolve({ code, out }));
  });
}

/** One phase: launch, run the script, record its tally, then quit (or kill). */
async function phase(name, configDir, script, args, { appDir, end = 'quit' } = {}) {
  const t0 = Date.now();
  let app, r = { code: 1, out: '' };
  try {
    app = await launch({ configDir, appDir });
    console.log(`[${name}] app up in ${Math.round((Date.now() - t0) / 1000)} s (${configDir})`);
    r = await node(script, args);
  } catch (e) {
    r.out += String(e?.stack ?? e);
    console.log(`[${name}] ${e?.message ?? e}`);
  } finally {
    if (app) await (end === 'kill' ? app.kill() : app.quit());
  }
  const tally = /(\d+) passed, (\d+) failed/.exec(r.out);
  results.push({ name, ok: r.code === 0, tally: tally ? `${tally[1]} passed, ${tally[2]} failed` : `exit ${r.code}`, secs: Math.round((Date.now() - t0) / 1000) });
  return r;
}

// --- fixture servers ------------------------------------------------------------------
const servers = [];
async function server(script, args, port) {
  try { await fetch(`http://127.0.0.1:${port}/`); console.log(`(port ${port} already serving — reusing it)`); return; } catch {}
  const p = spawn(process.execPath, [join(HERE, 'fixtures', script), ...args], { stdio: 'inherit' });
  servers.push(p);
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/`); return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`${script} did not start on :${port}`);
}

/** ffmpeg + yt-dlp for the offline suite: BRO_E2E_TOOLS, else an installed Bro Plus / Bro's tools folder. */
function findTools() {
  const cands = [process.env.BRO_E2E_TOOLS, join(process.env.APPDATA ?? '', 'bro-plus', 'tools'), join(process.env.APPDATA ?? '', 'bro-browser', 'tools')].filter(Boolean);
  return cands.find((d) => existsSync(join(d, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')));
}

/** A copy of the app built with only some plugins, under tests/e2e/.builds/<name> (node_modules resolve from the repo). */
function variantBuild(name, plugins) {
  const out = join(HERE, '.builds', name);
  const env = { ...process.env };
  console.log(`\n$ BRO_PLUGINS=${plugins} node esbuild.mjs   (→ ${out})`);
  try {
    execFileSync(process.execPath, ['esbuild.mjs'], { cwd: ROOT, env: { ...env, BRO_PLUGINS: plugins }, stdio: 'inherit' });
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(ROOT, 'dist'), join(out, 'dist'), { recursive: true });
    writeFileSync(join(out, 'package.json'), readFileSync(join(ROOT, 'package.json')));
  } finally {
    // Put the normal build (plugins.config.json) back in dist/ and src/generated/.
    delete env.BRO_PLUGINS;
    console.log('$ node esbuild.mjs   (restoring the default build)');
    execFileSync(process.execPath, ['esbuild.mjs'], { cwd: ROOT, env, stdio: 'inherit' });
  }
  return out;
}

const steps = {
  async main() {
    const dir = fresh('main');
    await phase('main', dir, 'main-suite.mjs', ['run']);
    await phase('main (restore after restart)', dir, 'main-suite.mjs', ['restore-check']);
  },
  private: () => phase('private', fresh('private'), 'private-suite.mjs'),
  'context-menu': () => phase('context-menu', fresh('ctx'), 'context-menu-suite.mjs'),
  'dead-tab': () => phase('dead-tab', fresh('dead'), 'dead-tab.mjs'),
  stress: () => phase('open-close stress', fresh('stress'), 'open-close-stress.mjs', ['10', '0']),
  'library-tab': () => phase('library-tab', fresh('libtab'), 'library-tab-suite.mjs'),
  async profiles() {
    await server('download-server.mjs', ['8765'], 8765);
    const dir = fresh('profiles');
    await phase('profiles', dir, 'profiles-suite.mjs', ['run']);
    const r = await phase('profiles (after restart)', dir, 'profiles-suite.mjs', ['restart']);
    const id = /WORK_ID=(\S+)/.exec(r.out)?.[1];
    await phase('profiles (purged on relaunch)', dir, 'profiles-suite.mjs', ['purged', id ?? 'missing']);
  },
  async downloads() {
    await server('download-server.mjs', ['8765'], 8765);
    const dir = fresh('downloads');
    const dl = join(dir, 'downloads');
    mkdirSync(dl, { recursive: true });
    await phase('downloads', dir, 'downloads-suite.mjs', ['run', dl]);
    await phase('downloads (crash mid-download)', dir, 'downloads-suite.mjs', ['crash-start', dl], { end: 'kill' });
    await phase('downloads (resume after crash)', dir, 'downloads-suite.mjs', ['crash-check', dl]);
  },
  async offline() {
    const tools = findTools();
    if (!tools) { results.push({ name: 'offline', ok: false, tally: 'SKIPPED: no ffmpeg (set BRO_E2E_TOOLS to a folder with ffmpeg + yt-dlp)', secs: 0 }); return; }
    const media = join(tmpdir(), 'bro-plus-e2e-media');
    console.log(`\nmaking test videos in ${media} with ${tools}`);
    makeOfflineMedia(join(tools, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), media);
    await server('offline-server.mjs', ['8766', media], 8766);
    const dir = fresh('offline');
    cpSync(tools, join(dir, 'tools'), { recursive: true }); // skip the ~50 MB first-run download
    const dl = join(dir, 'saved');
    mkdirSync(dl, { recursive: true });
    await phase('offline', dir, 'offline-suite.mjs', ['run', dl, ...(YOUTUBE ? ['youtube'] : [])]);
  },
  async 'plugin-seams'() {
    await phase('plugin seams (full build)', fresh('seams'), 'plugin-seams-suite.mjs', ['full']);
    const appDir = variantBuild('browser-only', 'overlay-hiding,opacity');
    await phase('plugin seams (browser-only build)', fresh('seams-bo'), 'plugin-seams-suite.mjs', ['browser-only'], { appDir });
  },
};

const t0 = Date.now();
try {
  for (const s of suites) await steps[s]();
} finally {
  for (const p of servers) p.kill();
  if (!KEEP) for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

console.log('\n=== e2e summary ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(36)} ${r.tally}  (${r.secs} s)`);
console.log(`${Math.round((Date.now() - t0) / 60000)} min${KEEP ? `; config dirs kept:\n  ${dirs.join('\n  ')}` : ''}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
