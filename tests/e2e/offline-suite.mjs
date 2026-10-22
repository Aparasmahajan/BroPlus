// "Save for offline" checks against a running Bro Plus (main :9229) + fixtures/offline-server.mjs (:8766).
//   node offline-suite.mjs run <empty-download-folder> [youtube]
// Fetches the real video tools (~50 MB) on the first run if they aren't in <userData>/tools yet
// (run-all.mjs copies an existing install there).
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectMain, chromeEval, checker, waitFor as wait0, sleep } from './lib.mjs';

const [, , phase = 'run', DIR, extra] = process.argv;
if (!DIR) throw new Error('pass a download folder');
const SRV = 'http://127.0.0.1:8766';
const waitFor = (fn, ms = 60000, every = 400) => wait0(fn, ms, every);
const { M } = await connectMain();
const C = await chromeEval(M);
/** The app's own video tools (<userData>/tools — BRO_PLUS_CONFIG_DIR/tools under the test runner). */
const TOOLS = join(await M(`return E.app.getPath('userData')`), 'tools');
/** Evaluate in the tab showing a URL. */
const T = (urlPart, js) => M(`const w = E.webContents.getAllWebContents().find(w => w.getURL().includes(${JSON.stringify(urlPart)})); return w ? w.executeJavaScript(${JSON.stringify(js)}) : '__none__'`);
const items = () => C('bro.getOffline()');
const active = async () => (await C('bro.listTabs()')).find((t) => t.active);
const { check, done } = checker();

const ended = (title, ms = 240000) => waitFor(async () => {
  const o = (await items()).find((x) => x.title === title);
  return o && ['completed', 'failed', 'cancelled'].includes(o.status) ? o : false;
}, ms, 800);
const open = async (path) => {
  await C(`bro.navigate(${JSON.stringify(SRV + path)})`);
  await waitFor(async () => (await active())?.url === SRV + path && !(await active()).loading, 60000);
};
/** Size of a fixture file, straight from the server (whatever ffmpeg produced it). */
const sizeOf = async (p) => Number((await fetch(SRV + p, { method: 'HEAD' })).headers.get('content-length'));
const probe = (file) => {
  try { execFileSync(join(TOOLS, 'ffmpeg.exe'), ['-hide_banner', '-i', file], { stdio: 'pipe' }); } catch (e) { return String(e.stderr); }
  return '';
};

await C(`bro.setPrefs({ downloadDir: ${JSON.stringify(DIR)}, videoQuality: 720, videoSubtitles: true })`);
await sleep(300);

if (phase === 'run') {
  // 0. Page without video, before the tools exist → just the page, no 50 MB download.
  const before = await C('bro.getVideoTools()');
  if (!before.ready) {
    await open('/plain.html');
    await C(`bro.saveOffline('page+video')`);
    const p0 = await ended('Just Text', 60000);
    check('no video + no tools: saves the page only', p0?.status === 'completed' && existsSync(join(p0.folder, 'page.mhtml')), p0 && `${p0.status} ${p0.stage}`);
    check('…without fetching the video tools', !(await C('bro.getVideoTools()')).installing && !(await C('bro.getVideoTools()')).ready);

    // 1. Fetch the tools (checksums verified inside).
    await C('bro.installVideoTools()');
    const vt = await waitFor(async () => { const s = await C('bro.getVideoTools()'); return !s.installing && (s.ready || s.error) ? s : false; }, 600000, 1500);
    check('video tools download + verify', vt?.ready, vt?.error ?? `yt-dlp ${vt?.ytdlpVersion}`);
  } else {
    console.log('(tools already installed — skipping first-run checks)');
  }

  // 2. A page with an H.264 video: page + video + player.
  await open('/video.html');
  const lit = await waitFor(async () => (await active())?.hasVideo, 30000);
  check('tab notices the video (button lights up)', !!lit);
  await C(`bro.saveOffline('page+video')`);
  const o1 = await ended('Lesson One');
  const f1 = o1 ? readdirSync(o1.folder) : [];
  check('page + video saved', o1?.status === 'completed' && o1.videos === 1, o1 && `${o1.status} ${o1.stage} ${o1.error ?? ''} [${f1.join(', ')}]`);
  check('…page.mhtml contains the page text', f1.includes('page.mhtml') && readFileSync(join(o1.folder, 'page.mhtml'), 'utf8').includes('Some lesson text'));
  check('…index.html player written', f1.includes('index.html'));
  const v1 = f1.find((n) => n.endsWith('.mp4'));
  check('…the video is byte-identical to the original (no needless re-encode)', v1 && statSync(join(o1.folder, v1)).size === await sizeOf('/clip.mp4'), v1 && String(statSync(join(o1.folder, v1)).size));

  // 3. Open it: the offline player plays the local file.
  await C(`bro.offlineAction(${JSON.stringify(o1?.id)}, 'open')`);
  const ready = await waitFor(async () => {
    const r = await T('index.html', `(() => { const v = document.querySelector('video'); return v && v.readyState >= 1 ? v.duration : 0; })()`);
    return r && r !== '__none__' ? r : false;
  }, 30000);
  check('offline player loads the saved video', ready > 9 && ready < 11, String(ready));
  // …and the saved page opens too.
  const mhtml = 'file:///' + join(o1.folder, 'page.mhtml').replace(/\\/g, '/');
  await C(`bro.navigate(${JSON.stringify(mhtml)})`);
  // Saved archives run with scripts off, so ask the tab, not the page.
  const title = await waitFor(() => M(`return E.webContents.getAllWebContents().find(w => w.getURL().endsWith('page.mhtml') && !w.isLoading())?.getTitle()`), 30000);
  check('saved page.mhtml opens in Bro', title === 'Lesson One', String(title));

  // 4. A format Chromium can't play (AVI / MPEG-4 Part 2 + MP3) → converted to H.264 MP4.
  await open('/avi.html');
  await waitFor(async () => (await active())?.hasVideo, 20000);
  await C(`bro.saveOffline('video')`);
  const o2 = await ended('Old Format Lesson');
  const f2 = o2 ? readdirSync(o2.folder) : [];
  const v2 = f2.find((n) => n.endsWith('.mp4'));
  check('unplayable AVI converted to MP4', o2?.status === 'completed' && !!v2 && !f2.some((n) => n.endsWith('.avi')), o2 && `${o2.status} ${o2.error ?? ''} [${f2.join(', ')}]`);
  check('…as H.264', v2 && /Video: h264/.test(probe(join(o2.folder, v2))));
  check('…"video only" has no page snapshot', !f2.includes('page.mhtml'));

  // 5. Pause in the middle, resume, and get the whole file.
  await open('/slow.html');
  await waitFor(async () => (await active())?.hasVideo, 20000);
  await C(`bro.saveOffline('video')`);
  const mid = await waitFor(async () => { const o = (await items()).find((x) => x.title === 'Slow Lesson'); return o && o.status === 'working' && o.received > 200000 ? o : false; }, 90000);
  check('slow download reports progress', !!mid, mid && `${mid.received}/${mid.total} @ ${Math.round(mid.speed / 1024)} KB/s`);
  await C(`bro.offlineAction(${JSON.stringify(mid?.id)}, 'pause')`);
  await sleep(2500);
  const paused = (await items()).find((x) => x.id === mid?.id);
  const part = readdirSync(mid.folder).find((n) => n.endsWith('.part'));
  check('pause stops it and keeps the partial file', paused?.status === 'paused' && !!part, `${paused?.status} ${part ?? 'no .part'}`);
  await C(`bro.offlineAction(${JSON.stringify(mid?.id)}, 'resume')`);
  const o3 = await ended('Slow Lesson', 180000);
  const v3 = o3 && readdirSync(o3.folder).find((n) => n.endsWith('.mp4'));
  check('resume finishes the whole file', o3?.status === 'completed' && v3 && statSync(join(o3.folder, v3)).size === await sizeOf('/slow.mp4'), o3 && `${o3.status} ${v3 && statSync(join(o3.folder, v3)).size}`);

  // 5b. A page with several videos (a course page): all of them, in a player with a lesson list.
  await open('/course.html');
  await waitFor(async () => (await active())?.hasVideo, 20000);
  await C(`bro.saveOffline('page+video')`);
  const oc = await ended('Three Lessons');
  check('page with 3 videos saves all 3', oc?.status === 'completed' && oc.videos === 3, oc && `${oc.status} ${oc.videos} ${oc.error ?? ''} [${readdirSync(oc.folder).join(', ')}]`);
  await C(`bro.offlineAction(${JSON.stringify(oc?.id)}, 'open')`);
  const lessons = await waitFor(async () => {
    const r = await T('Three%20Lessons/index.html', `document.querySelectorAll('#list button').length`);
    return r && r !== '__none__' ? r : false;
  }, 30000);
  check('…player lists the 3 lessons', lessons === 3, String(lessons));
  const switched = await T('Three%20Lessons/index.html', `(document.querySelectorAll('#list button')[2].click(), new Promise(r => setTimeout(() => r(decodeURIComponent(document.querySelector('video').src)), 1500)))`);
  check('…clicking a lesson plays it', /clip3|\(3\)/.test(String(switched)) || (!!oc && String(switched).includes(readdirSync(oc.folder).filter((n) => n.endsWith('.mp4')).sort()[2])), String(switched).split('/').pop());

  // 6. A page with no video once the tools exist: yt-dlp finds nothing → page only, clear message.
  await open('/plain.html');
  await C(`bro.saveOffline('page+video')`);
  const o4 = await waitFor(async () => {
    const all = (await items()).filter((x) => x.title === 'Just Text');
    const o = all.sort((a, b) => b.started - a.started)[0];
    return o && ['completed', 'failed'].includes(o.status) && all.length >= (before.ready ? 1 : 2) ? o : false;
  }, 120000, 800);
  check('no video on the page: page kept, says why', o4?.status === 'completed' && /No video/.test(o4.stage), o4 && `${o4.status} ${o4.stage}`);

  // 7. Delete removes the folder.
  await C(`bro.offlineAction(${JSON.stringify(o4?.id)}, 'delete')`);
  await sleep(1500);
  check('delete removes the saved files', o4 && !existsSync(o4.folder));

  // 8. Sites that block download tools: the stream comes through the browser's own connection.
  const newest = async (t0, ms = 240000) => {
    const done = await waitFor(async () => {
      const o = (await items()).find((x) => x.started >= t0);
      return o && ['completed', 'failed', 'cancelled'].includes(o.status) ? o : false;
    }, ms, 800);
    if (!done) { const o = (await items()).find((x) => x.started >= t0); console.log(`  (gave up after ${ms / 1000} s: ${o ? `${o.status} — ${o.stage} ${o.received}/${o.total} ${o.error ?? ''}` : 'no save started'})`); }
    return done;
  };
  const streams = (file) => {
    const p = probe(file);
    const v = /Video: (\w+)[^\n]*?, (\d+)x(\d+)/.exec(p);
    const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(p);
    return { video: v?.[1], height: Number(v?.[3] ?? 0), audio: /Audio: (\w+)/.exec(p)?.[1], seconds: d ? Number(d[2]) * 60 + Number(d[3]) : 0 };
  };
  const guard = async () => (await fetch(SRV + '/guard-stats')).json();

  await C(`bro.setPrefs({ videoQuality: 360 })`);
  await open('/guarded.html');
  await waitFor(async () => (await active())?.hasVideo, 20000);
  const blocked0 = (await guard()).blocked;
  let t0 = Date.now();
  await C(`bro.saveOffline('video')`);
  const g1 = await newest(t0);
  const g1v = g1 && readdirSync(g1.folder).find((n) => n.endsWith('.mp4'));
  const s1 = g1v ? streams(join(g1.folder, g1v)) : {};
  check('blocked site: HLS saved through the browser (360p, AES-128 encrypted pieces)', g1?.status === 'completed' && s1.video === 'h264' && s1.height === 360 && !!s1.audio, g1 && `${g1.status} ${g1.error ?? ''} ${JSON.stringify(s1)} [${readdirSync(g1.folder).join(', ')}]`);
  check('…whole video (12 s)', Math.abs((s1.seconds ?? 0) - 12) < 0.6, String(s1.seconds));
  // The real yt-dlp, even with the right cookie, is turned away by this site.
  let ytdlpSays = '';
  try {
    execFileSync(join(TOOLS, 'yt-dlp.exe'), ['--ignore-config', '--simulate', '--add-header', 'Cookie:bro_session=ok', SRV + '/guard/master.m3u8'], { stdio: 'pipe' });
  } catch (e) {
    ytdlpSays = String(e.stderr);
  }
  check('…(yt-dlp on its own really is refused there)', /403/.test(ytdlpSays), ytdlpSays.split('\n').find((l) => l.startsWith('ERROR')) ?? 'yt-dlp succeeded');
  check('…no leftover pieces', g1 && !readdirSync(g1.folder).some((n) => n.startsWith('.bro-stream-')));

  await C(`bro.setPrefs({ videoQuality: 720 })`);
  t0 = Date.now();
  await C(`bro.saveOffline('video')`);
  const g2 = await newest(t0);
  const g2v = g2 && readdirSync(g2.folder).find((n) => n.endsWith('.mp4'));
  const s2 = g2v ? streams(join(g2.folder, g2v)) : {};
  check('720p variant with its separate audio track joined into one MP4', g2?.status === 'completed' && s2.height === 720 && !!s2.audio, g2 && `${g2.status} ${g2.error ?? ''} ${JSON.stringify(s2)}`);

  await open('/drm.html');
  await waitFor(async () => (await active())?.hasVideo, 20000);
  t0 = Date.now();
  await C(`bro.saveOffline('video')`);
  const g3 = await newest(t0);
  check('DRM stream refused with a clear message', g3?.status === 'failed' && /DRM/.test(g3.error ?? ''), g3 && `${g3.status} ${g3.error}`);

  await open('/guard-file.html');
  await waitFor(async () => (await active())?.hasVideo, 20000);
  t0 = Date.now();
  await C(`bro.saveOffline('page+video')`);
  const g4 = await newest(t0);
  const g4v = g4 && readdirSync(g4.folder).find((n) => n.endsWith('.mp4'));
  check('blocked site: plain video file saved through the browser', g4?.status === 'completed' && g4v && statSync(join(g4.folder, g4v)).size === await sizeOf('/clip.mp4'), g4 && `${g4.status} ${g4.stage} ${g4.error ?? ''}`);

  // 9. Optional: a real YouTube video (needs internet) at 360p.
  if (extra === 'youtube') {
    await C(`bro.setPrefs({ videoQuality: 360 })`);
    await C(`bro.navigate('https://www.youtube.com/watch?v=jNQXAC9IVRw')`);
    // The previous page also had a video: wait until the tab really is on YouTube.
    await waitFor(async () => { const a = await active(); return a?.url.includes('youtube.com/watch') && a.hasVideo; }, 60000);
    const t5 = Date.now();
    await C(`bro.saveOffline('page+video')`);
    // The save takes the video's own title from YouTube (the tab may still say just "YouTube").
    const o5 = await waitFor(async () => {
      const o = (await items()).find((x) => x.started >= t5);
      return o && ['completed', 'failed', 'cancelled'].includes(o.status) ? o : false;
    }, 300000, 800);
    check('…named after the video, not the site', o5 && o5.title !== 'YouTube' && !/ - YouTube$/.test(o5.title), o5?.title);
    const f5 = o5 ? readdirSync(o5.folder) : [];
    check('YouTube video saved', o5?.status === 'completed' && o5.videos === 1, o5 && `${o5.status} ${o5.error ?? ''} [${f5.join(', ')}]`);
    const v5 = f5.find((n) => n.endsWith('.mp4'));
    const h5 = v5 && /Video: h264[^\n]*?, (\d+)x(\d+)/.exec(probe(join(o5.folder, v5)));
    check('…as H.264 MP4 at ≤360p', !!h5 && Number(h5[2]) <= 360, h5 ? `${h5[1]}x${h5[2]}` : 'not h264');
    check('…with English subtitles', f5.some((n) => n.endsWith('.vtt')), f5.filter((n) => n.endsWith('.vtt')).join(', '));

    // A single save on a page yt-dlp sees as a whole playlist (like a Udemy lecture → its course):
    // it must stop instead of fetching every video.
    await C(`bro.navigate('https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi')`);
    await waitFor(async () => { const a = await active(); return a?.url.includes('/playlist') && !a.loading; }, 60000);
    const t6 = Date.now();
    await C(`bro.saveOffline('video')`);
    const o6 = await newest(t6, 240000);
    const f6 = o6 && existsSync(o6.folder) ? readdirSync(o6.folder) : [];
    check('single save on a playlist page does not download the playlist', !!o6 && o6.status === 'failed' && !f6.length, o6 && `${o6.status} after ${Math.round((o6.finished - o6.started) / 1000)} s · ${o6.error} [${f6.join(', ')}]`);
  }
}

done();
