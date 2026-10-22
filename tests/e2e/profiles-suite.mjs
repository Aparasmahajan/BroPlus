// Profile checks against a running Bro Plus (main :9229) + fixtures/download-server.mjs (:8765).
//   node profiles-suite.mjs run          — create "Work", isolation, history/bookmarks, extensions, ads, links, menu
//   node profiles-suite.mjs restart      — (after a graceful close + relaunch) Work tab restored in Work; then delete Work
//   node profiles-suite.mjs purged <id>  — (after another relaunch) Work's on-disk folder is gone
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMain, chromeEval, checker, waitFor, sleep } from './lib.mjs';

const phase = process.argv[2] || 'run';
const { M } = await connectMain();
const C = await chromeEval(M);
await waitFor(() => M(`return E.BrowserWindow.getAllWindows().some(w => w.isVisible())`), 120000);
const { check, done } = checker();
const userData = await M(`return E.app.getPath('userData')`);
const tabs = () => C('bro.listTabs()');
const active = async () => (await tabs()).find((t) => t.active);
const waitLoaded = (urlPart) => waitFor(() => M(`const w = E.webContents.getAllWebContents().find(x => x.getURL().includes(${JSON.stringify(urlPart)})); return !!w && !w.isLoading()`), 60000);

if (phase === 'run') {
  const before = (await C('bro.getProfiles()')).profiles.length;
  const workId = await C(`bro.createProfile('Work', '#16a34a')`);
  const t1 = await waitFor(async () => { const a = await active(); return a && a.profileId === workId ? a : false; }, 15000);
  check('creating a profile opens a tab in it', !!t1 && (await C('bro.getProfiles()')).profiles.length === before + 1, t1 && t1.partition);
  check('…its own persistent partition', t1 && t1.partition === `persist:bro-profile-${workId}`);
  check('switcher shows the current profile', (await C(`document.getElementById('btn-profile').textContent`)) === 'W' && (await C('bro.getProfiles()')).current === workId);

  // Isolation: cookie set in Work never reaches the default profile.
  await C(`bro.navigate('example.com/?bro-work=1')`);
  await waitLoaded('bro-work=1');
  await M(`const w = E.webContents.getAllWebContents().find(x => x.getURL().includes('bro-work=1')); await w.executeJavaScript("document.cookie = 'workonly=1; max-age=3600'"); return true`);
  await sleep(500);
  const ck = await M(`return [(await E.session.fromPartition('persist:bro-profile-${workId}').cookies.get({ name: 'workonly' })).length, (await E.session.defaultSession.cookies.get({ name: 'workonly' })).length]`);
  check('cookies stay inside their profile', ck[0] === 1 && ck[1] === 0, JSON.stringify(ck));
  await sleep(800);
  check('history is recorded in the Work profile', await waitFor(async () => (await C('bro.getHistory()')).some((h) => h.url.includes('bro-work=1')), 5000));
  await C(`bro.toggleBookmark('https://example.com/?bro-work=1', 'Work bookmark')`);
  await sleep(300);
  check('…and the bookmark too', (await C('bro.getBookmarks()')).some((b) => b.url.includes('bro-work=1')));
  check('Work tab shows the stripe and the extension toolbar follows its profile', (await C(`document.querySelectorAll('#tabs .tab.profiled').length`)) >= 1 && (await C(`document.getElementById('actions').getAttribute('partition')`)) === t1.partition);

  // Links opened from a Work tab stay in Work.
  const n = (await tabs()).length;
  await M(`const w = E.webContents.getAllWebContents().find(x => x.getURL().includes('bro-work=1')); await w.executeJavaScript("window.open('https://example.org/?from-work=1')", true); return true`);
  const child = await waitFor(async () => { const t = await tabs(); return t.length === n + 1 ? t.find((x) => x.url.includes('from-work') || x.active) : false; }, 15000);
  check('links opened from a Work tab open in Work', child && child.profileId === workId, child && child.profileId);

  // Ads blocked and extensions separate.
  const sess = `E.session.fromPartition('persist:bro-profile-${workId}')`;
  const pre = await M(`return ${sess}.getPreloadScripts().map(p => p.filePath.split(/[\\\\/]/).slice(-4).join('/'))`);
  check('ad blocking + YouTube shield are attached to the Work session', pre.some((p) => p.endsWith('preload/adblock.js')) && pre.some((p) => p.includes('adblocker-electron-preload')), JSON.stringify(pre));
  // A fresh test profile has no extensions: load a do-nothing one into Personal and make sure Work never sees it.
  const extDir = fileURLToPath(new URL('./fixtures/ext-hello', import.meta.url));
  await M(`const s = E.session.defaultSession; await (s.extensions ?? s).loadExtension(${JSON.stringify(extDir)}, { allowFileAccess: false }); return true`);
  const ext = await M(`const all = (s) => (s.extensions ? s.extensions.getAllExtensions() : s.getAllExtensions()).length; return [all(${sess}), all(E.session.defaultSession)]`);
  check('extensions are per profile (Work starts with none)', ext[0] === 0 && ext[1] >= 1, `work ${ext[0]}, default ${ext[1]}`);

  // Back to a default-profile tab: Library + switcher follow.
  const def = (await tabs()).find((t) => t.profileId === 'default' && !t.private);
  await C(`bro.activateTab(${def.id})`);
  const switched = await waitFor(async () => (await C('bro.getProfiles()')).current === 'default', 10000);
  check('activating a Personal tab makes Personal current', switched, JSON.stringify((await tabs()).filter((t) => t.active).map((t) => ({ id: t.id, profileId: t.profileId }))));
  const hist = await C('bro.getHistory()');
  check('switching to a Personal tab switches history back', !hist.some((h) => h.url.includes('bro-work=1')) && (await C('bro.getProfiles()')).current === 'default');
  check('…and bookmarks', !(await C('bro.getBookmarks()')).some((b) => b.url.includes('bro-work=1')));
  check('…and the switcher', (await C(`document.getElementById('btn-profile').textContent`)) === 'P' && !(await C(`document.getElementById('actions').hasAttribute('partition')`)));

  // Right-click on a Personal tab offers "Open link as ▸ Work".
  const menu = await M(`let shown; const orig = E.Menu.prototype.popup; E.Menu.prototype.popup = function () { shown = this; };
    const w = E.webContents.getAllWebContents().find(x => x.session === E.session.defaultSession && /^https?:|start\\.html/.test(x.getURL()) && !x.getURL().includes('chrome-extension'));
    w.emit('context-menu', { preventDefault() {} }, { x: 1, y: 1, linkURL: 'https://example.net/', linkText: '', pageURL: '', frameURL: '', srcURL: '', mediaType: 'none', hasImageContents: false, isEditable: false, selectionText: '', titleText: '', altText: '', suggestedFilename: '', selectionRect: { x: 0, y: 0, width: 0, height: 0 }, selectionStartOffset: 0, referrerPolicy: { policy: 'default', url: '' }, misspelledWord: '', dictionarySuggestions: [], frameCharset: '', inputFieldType: 'none', spellcheckEnabled: false, menuSourceType: 'mouse', mediaFlags: {}, editFlags: {} });
    E.Menu.prototype.popup = orig;
    const item = shown && shown.items.find(i => i.label === 'Open link as');
    return item ? item.submenu.items.map(i => i.label) : null;`);
  check('right-click on a Personal tab offers "Open link as ▸ Work"', Array.isArray(menu) && menu.includes('Work'), JSON.stringify(menu));

  // Downloads are tagged with their profile.
  await M(`${sess}.downloadURL('http://127.0.0.1:8765/file.bin?name=work-dl.bin'); return true`);
  const dl = await waitFor(async () => (await C('bro.getDownloads()')).find((d) => d.filename.startsWith('work-dl')), 30000);
  check('downloads remember their profile', dl && dl.profileId === workId, dl && dl.profileId);

  // Leave a Work tab open for the restart check.
  const last = await M(`return require('fs').readFileSync(require('path').join(E.app.getPath('userData'), 'data', 'session-last.json'), 'utf8')`);
  check('the autosaved session records each tab\'s profile', last.includes(workId), '');
  console.log(`WORK_ID=${workId}`);
}

if (phase === 'restart') {
  const workId = JSON.parse(readFileSync(join(userData, 'data', 'profiles.json'), 'utf8')).profiles.find((p) => p.name === 'Work')?.id;
  const t = await waitFor(async () => (await tabs()).filter((x) => x.profileId === workId), 20000);
  check('after a restart, Work tabs come back in the Work profile', !!workId && t.length >= 1, `${t.length} Work tab(s)`);
  const ck = await M(`return (await E.session.fromPartition('persist:bro-profile-${workId}').cookies.get({ name: 'workonly' })).length`);
  check('…with their sign-in cookies still there (persistent profile)', ck === 1);
  const ok = await C(`bro.removeProfile(${JSON.stringify(workId)})`);
  const gone = await waitFor(async () => !(await tabs()).some((x) => x.profileId === workId) && (await C('bro.getProfiles()')).profiles.every((p) => p.id !== workId), 15000);
  const after = await tabs();
  check('deleting a profile closes its tabs', ok === true && gone, `removeProfile → ${ok}; tabs: ${JSON.stringify(after.map((x) => x.profileId))}`);
  const pd = await waitFor(() => { const d = JSON.parse(readFileSync(join(userData, 'data', 'profiles.json'), 'utf8')); return d.pendingDelete.includes(workId) && d; }, 5000); // stores write ~400 ms later
  check('…and schedules its data folder for deletion', !!pd);
  console.log(`WORK_ID=${workId}`);
}

if (phase === 'purged') {
  const workId = process.argv[3];
  check('the deleted profile\'s data folder is gone after relaunch', !existsSync(join(userData, 'Partitions', `bro-profile-${workId}`)) && !existsSync(join(userData, 'data', `history-${workId}.json`)));
  check('…and nothing is left pending', JSON.parse(readFileSync(join(userData, 'data', 'profiles.json'), 'utf8')).pendingDelete.length === 0);
}

done();
