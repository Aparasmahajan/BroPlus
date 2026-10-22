// Download-manager checks against a running Bro Plus (main :9229) + fixtures/download-server.mjs (:8765).
//   node downloads-suite.mjs run <downloadDir>
//   node downloads-suite.mjs crash-start <downloadDir>   (then kill the app hard, relaunch)
//   node downloads-suite.mjs crash-check <downloadDir>
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { connectMain, chromeEval, checker, waitFor as wait0, sleep } from './lib.mjs';

const [, , phase = 'run', DIR] = process.argv;
if (!DIR) throw new Error('pass a download folder');
const SRV = 'http://127.0.0.1:8765';
const srv = async (p, opts) => (await fetch(SRV + p, opts)).json().catch(() => null);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const waitFor = (fn, ms = 60000, every = 300) => wait0(fn, ms, every);
const { M } = await connectMain();
const C = await chromeEval(M);
const downloads = () => C('bro.getDownloads()');
const byName = async (name) => (await downloads()).find((d) => d.filename.startsWith(name.replace(/\.bin$/, '')));
const start = (q, opts = '') => M(`(${opts.includes('private') ? "E.session.fromPartition('bro-private')" : 'E.session.defaultSession'}).downloadURL(${JSON.stringify(SRV + q)}); return true`);
const { check, done } = checker();
const finished = (name, ms = 120000) => waitFor(async () => { const d = await byName(name); return d && ['completed', 'failed', 'cancelled'].includes(d.status) ? d : false; }, ms, 500);

await C(`bro.setPrefs({ downloadDir: ${JSON.stringify(DIR)}, askWhereToSave: false, downloadConnections: 8 })`);
await sleep(300);

if (phase === 'run') {
  // 1. Multi-connection download, byte-exact.
  await srv('/reset-stats');
  await start('/file.bin?name=t1-fast.bin');
  const d1 = await finished('t1-fast');
  const s1 = await srv('/stats');
  check('range-capable file uses the segmented engine', d1 && d1.engine === 'segmented', d1 && d1.engine);
  check('…with several parallel connections', s1.maxConcurrent >= 4, `max ${s1.maxConcurrent} concurrent`);
  check('…and finishes byte-exact', d1?.status === 'completed' && sha(d1.path) === s1.sha256, d1?.status);

  // 2. Pause / resume keeps the bytes.
  await start('/file.bin?name=t2-pause.bin&rate=262144');
  const mid = await waitFor(async () => { const d = await byName('t2-pause'); return d && d.received > 8 * 1024 * 1024 ? d : false; }, 90000);
  await C(`bro.downloadAction(${JSON.stringify(mid.id)}, 'pause')`);
  await sleep(1500);
  const p1 = await byName('t2-pause');
  await sleep(2000);
  const p2 = await byName('t2-pause');
  check('pause stops the download', p1.status === 'paused' && p2.received === p1.received, `${p1.status}, ${p1.received} → ${p2.received}`);
  check('…partial file kept on disk', existsSync(p1.path + '.brodownload'));
  await C(`bro.downloadAction(${JSON.stringify(mid.id)}, 'resume')`);
  const resumedAt = await waitFor(async () => { const d = await byName('t2-pause'); return d && d.status === 'downloading' && d.received >= p1.received ? d : false; }, 20000);
  check('resume continues from where it paused (not from 0)', !!resumedAt && resumedAt.received >= p1.received, resumedAt && `${resumedAt.received} ≥ ${p1.received}`);
  const d2 = await finished('t2-pause', 240000);
  check('…and finishes byte-exact', d2?.status === 'completed' && sha(d2.path) === (await srv('/stats')).sha256, d2?.status);

  // 3. Dropped connections are retried automatically.
  await srv('/reset-stats');
  await start('/file.bin?name=t3-flaky.bin&flaky=10');
  const d3 = await finished('t3-flaky', 180000);
  check('connections cut mid-transfer are retried automatically', d3?.status === 'completed' && d3.retries > 0, `${d3?.status}, ${d3?.retries} retries`);
  check('…and the file is still byte-exact', d3?.status === 'completed' && sha(d3.path) === (await srv('/stats')).sha256);

  // 4. File changed on the server while paused → starts over instead of mixing versions.
  await start('/file.bin?name=t4-changed.bin&rate=262144');
  const c1 = await waitFor(async () => { const d = await byName('t4-changed'); return d && d.received > 4 * 1024 * 1024 ? d : false; }, 90000);
  await C(`bro.downloadAction(${JSON.stringify(c1.id)}, 'pause')`);
  await sleep(1000);
  const ver = await (await fetch(SRV + '/bump', { method: 'POST' })).text();
  await C(`bro.downloadAction(${JSON.stringify(c1.id)}, 'resume')`);
  const d4 = await finished('t4-changed', 300000);
  const s4 = await srv('/stats');
  check('a file that changed on the server is re-fetched, not corrupted', d4?.status === 'completed' && sha(d4.path) === s4.sha256, `server v${ver}, ${d4?.status}`);

  // 5. No range support → Chromium's engine.
  await start('/norange.bin?name=t5-norange.bin');
  const d5 = await finished('t5-norange');
  check('server without ranges falls back to the browser engine', d5?.engine === 'browser' && d5.status === 'completed', `${d5?.engine} ${d5?.status}`);
  check('…byte-exact', d5?.status === 'completed' && sha(d5.path) === (await srv('/stats')).sha256);

  // 6. Cancel removes the partial file.
  await start('/file.bin?name=t6-cancel.bin&rate=131072');
  const k = await waitFor(async () => { const d = await byName('t6-cancel'); return d && d.engine === 'segmented' && d.received > 1024 * 1024 ? d : false; }, 90000);
  await C(`bro.downloadAction(${JSON.stringify(k.id)}, 'cancel')`);
  await sleep(2500);
  const k2 = await byName('t6-cancel');
  check('cancel stops it and deletes the partial file', k2.status === 'cancelled' && !existsSync(k.path + '.brodownload') && !existsSync(k.path), k2.status);

  // 7. Private downloads are listed but never stored.
  await start('/file.bin?name=t7-private.bin', 'private');
  const d7 = await finished('t7-private');
  await sleep(1500);
  const stored = await M(`return require('fs').readFileSync(require('path').join(E.app.getPath('userData'), 'data', 'downloads.json'), 'utf8')`);
  check('download from a private tab completes and is marked private', d7?.status === 'completed' && d7.private === true);
  check('…but is never written to the downloads file', !stored.includes('t7-private'));

  // 8. Library page shows the downloads with the right buttons.
  await M(`const c = E.webContents.getAllWebContents().find(w => w.getURL().endsWith('dist/ui/index.html')); await c.executeJavaScript("bro.runCommand('app.downloads')"); return true`);
  const lib = await waitFor(() => M(`const l = E.webContents.getAllWebContents().find(w => w.getURL().includes('library.html?tab') && !w.isLoading()); return l && l.executeJavaScript("({ active: document.getElementById('tab-downloads').classList.contains('active'), rows: document.querySelectorAll('.dl-item').length, open: document.querySelectorAll('.dl-item [data-action=open]').length })").then(r => r.rows >= 6 && r)`), 30000);
  check('Ctrl/Cmd+J opens the Library on Downloads with the rows', lib && lib.active && lib.rows >= 6 && lib.open >= 4, JSON.stringify(lib));
  const btn = await C(`({ hidden: document.getElementById('btn-downloads').hidden })`);
  check('toolbar shows the downloads button', btn.hidden === false);
}

if (phase === 'crash-start') {
  await start('/file.bin?name=t8-crash.bin&rate=196608');
  const d = await waitFor(async () => { const x = await byName('t8-crash'); return x && x.received > 10 * 1024 * 1024 ? x : false; }, 120000);
  await sleep(1500); // let the progress be saved (every second)
  console.log(`CRASH-START received=${d.received}`);
}

if (phase === 'crash-check') {
  const first = await waitFor(async () => { const x = await byName('t8-crash'); return x && x.received > 0 ? x : false; }, 60000, 200);
  const files = readdirSync(DIR).filter((f) => f.startsWith('t8-crash'));
  check('after a crash the download is still listed with its progress', !!first && first.received > 5 * 1024 * 1024, first && `${first.status}, ${first.received} bytes, files: ${files.join(', ')}`);
  const resumed = await waitFor(async () => { const x = await byName('t8-crash'); return x && x.status === 'downloading' ? x : false; }, 30000);
  check('…and resumes by itself after relaunch', !!resumed);
  const d = await finished('t8-crash', 400000);
  check('…finishing byte-exact', d?.status === 'completed' && sha(d.path) === (await srv('/stats')).sha256, d?.status);
}

done();
