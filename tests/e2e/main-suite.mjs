// End-to-end checks against a running Bro Plus (main inspector :9229, pages :9333; see launch.mjs).
// usage: node main-suite.mjs [phase]   phase = run (default) | restore-check
import { readFileSync } from 'node:fs';
import { connectMain, page, waitFor, sleep, checker, exceptionsOf } from './lib.mjs';
const phase = process.argv[2] || 'run';

const { M } = await connectMain();
const visible = await waitFor(() => M(`return E.BrowserWindow.getAllWindows().some(w => w.isVisible())`), 120000);

const { check, done } = checker();
check('window becomes visible', !!visible);
if (phase === 'run') await sleep(8000); // this machine needs CPU time to settle after launch

const chrome = await page('dist/ui/index.html');
const settings = await page('settings.html');
const library = await page('library.html');
const C = (e) => chrome.evaluate(e);
const S = (e) => settings.evaluate(e);
const L = (e) => library.evaluate(e);
const press = (keyCode, mods) => M(`const wc = E.webContents.getAllWebContents().find(w => w.getURL().endsWith('dist/ui/index.html')); wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: '${keyCode}', modifiers: ${JSON.stringify(mods)} }); wc.sendInputEvent({ type: 'keyUp', keyCode: '${keyCode}', modifiers: ${JSON.stringify(mods)} }); return true`);
const tabCount = () => C(`document.querySelectorAll('#tabs .tab').length`);

if (phase === 'restore-check') {
  const tabs = await waitFor(() => C(`bro.listTabs().then(t => t.length > 1 && t.map(x => ({url: x.url, sleeping: x.sleeping, active: x.active})))`), 30000);
  console.log(JSON.stringify(tabs));
  check('last session restored on launch', tabs && tabs.some((t) => t.url.includes('example.com')) && tabs.some((t) => t.url.includes('example.org')), `${tabs.length} tabs`);
  check('restored background tabs are asleep', tabs && tabs.some((t) => t.sleeping && !t.active));
  done();
}

await C(`bro.getSearch().then(s => bro.setSearch({ ...s, defaultKeyword: 'g' }))`); await sleep(300);
// --- chrome bar ------------------------------------------------------------
check('chrome renders tabs', (await tabCount()) >= 1, `${await tabCount()} tab(s)`);
check('omnibox placeholder follows default engine', (await C(`document.getElementById('omnibox').placeholder`)).startsWith('Search Google'));

// IPC: every bridge "get" resolves (would reject with "No handler registered" before the fix).
const gets = ['getShortcuts', 'getSearch', 'getSessions', 'getPrefs', 'getDataDir', 'getBookmarks', 'getHistory', 'listTabs', 'getOverlayMode', 'activePlugins', 'getProfiles', 'getDownloads', 'getOffline', 'getVideoTools'];
const getRes = await C(`Promise.all(${JSON.stringify(gets)}.map(k => bro[k]().then(() => 'ok', e => k + ': ' + e.message)))`);
check('all bridge getters have main handlers', getRes.every((r) => r === 'ok'), getRes.filter((r) => r !== 'ok').join('; '));
// Screen-share hiding, opacity and ad blocking are plugins now, reached over the generic bus.
const plugins = (await C(`bro.activePlugins()`)).map((p) => p.id);
const plRes = await C(`Promise.all(['overlay:get', 'opacity:get', 'adblock:get'].map(ch => bro.plugin.invoke(ch).then(() => 'ok', e => ch + ': ' + e.message)))`);
check('plugin "get" channels answer on the bus', plRes.every((r) => r === 'ok'), `${plugins.join(',')} → ${plRes.join('; ')}`);
check('screen-share hiding is on by default', (await C(`bro.plugin.invoke('overlay:get')`)) === true);

// --- shortcuts: real key press through before-input-event --------------------
const before = await tabCount();
await press('T', ['control']);
check('Ctrl+T key press opens a tab', await waitFor(async () => (await tabCount()) === before + 1, 10000), `${before} → ${await tabCount()}`);
await press('W', ['control']);
check('Ctrl+W key press closes it', await waitFor(async () => (await tabCount()) === before, 10000));

// Rebind New Tab → Ctrl+Alt+N; old key must stop working, menu label must follow.
await C(`bro.setShortcutKeys('tab.new', ['CommandOrControl+Alt+N'])`);
await sleep(400);
check('rebinding saved', (await C(`bro.getShortcuts().then(s => JSON.stringify(s.config.overrides['tab.new']))`)) === '["CommandOrControl+Alt+N"]');
const menuAccel = await M(`const m = E.Menu.getApplicationMenu(); return m.items.find(i => i.label === 'File').submenu.items.find(i => i.label === 'New Tab').accelerator`);
check('app menu shows the new binding', menuAccel === 'CommandOrControl+Alt+N', String(menuAccel));
const b2 = await tabCount();
await press('T', ['control']);
await sleep(800);
check('old Ctrl+T no longer opens a tab', (await tabCount()) === b2);
await press('N', ['control', 'alt']);
check('new Ctrl+Alt+N opens a tab', await waitFor(async () => (await tabCount()) === b2 + 1, 10000));
await C(`bro.runCommand('tab.close')`);
await C(`bro.resetShortcuts('tab.new')`);
await sleep(300);
check('per-command reset', (await C(`bro.getShortcuts().then(s => !('tab.new' in s.config.overrides) || s.config.overrides['tab.new'][0] === 'CommandOrControl+T')`)));

// Stealing: give Ctrl+Shift+H (capture toggle, overlay-hiding plugin) to Reload → removed from capture toggle.
await C(`bro.setShortcutKeys('nav.reload', ['CommandOrControl+R', 'F5', 'CommandOrControl+Shift+H'])`);
await sleep(300);
const capKeys = await C(`bro.getShortcuts().then(s => JSON.stringify(s.config.overrides['stealth.toggleCapture'] ?? null))`);
check('assigning a used key moves it from its old command', capKeys === '[]', capKeys);
check('…and the global hotkey is released', (await M(`return E.globalShortcut.isRegistered('CommandOrControl+Shift+H')`)) === false);

// Master switch cuts the BroBrowsing globals, never itself.
await C(`bro.resetShortcuts()`);
await sleep(300);
check('full reset re-registers Ctrl+Shift+H', (await M(`return E.globalShortcut.isRegistered('CommandOrControl+Shift+H')`)) === true);
await C(`bro.toggleMaster()`);
await sleep(300);
const cut = await M(`return [E.globalShortcut.isRegistered('CommandOrControl+Shift+H'), E.globalShortcut.isRegistered('CommandOrControl+Shift+\`')]`);
check('master switch cuts BroBrowsing globals, keeps itself', cut[0] === false && cut[1] === true, JSON.stringify(cut));
await C(`bro.toggleMaster()`);
await sleep(300);
check('master switch brings them back', (await M(`return E.globalShortcut.isRegistered('CommandOrControl+Shift+H')`)) === true);

// Recording suspends hotkeys.
await C(`bro.setShortcutRecording(true)`); await sleep(200);
const recOff = await M(`return E.globalShortcut.isRegistered('CommandOrControl+Shift+H')`);
await C(`bro.setShortcutRecording(false)`); await sleep(200);
check('recording a key suspends global hotkeys', recOff === false);

// Custom shortcut: open "yt lofi" in a new tab via a key.
await C(`bro.saveCustomShortcut({ id: '', label: 'Lofi', target: 'yt lofi', keys: ['CommandOrControl+Alt+L'], global: false, newTab: true })`);
await sleep(300);
const b3 = await tabCount();
await press('L', ['control', 'alt']);
check('custom shortcut opens its target in a new tab', await waitFor(async () => (await tabCount()) === b3 + 1, 10000));
const ytUrl = await waitFor(() => M(`const u = E.webContents.getAllWebContents().map(w => w.getURL()).find(u => u.includes('youtube.com/results')); return u || false`), 30000);
check('…using the "yt" site-search keyword', !!ytUrl, String(ytUrl));
await C(`bro.runCommand('tab.close')`);
await C(`bro.getShortcuts().then(s => s.config.custom.forEach(c => bro.removeCustomShortcut(c.id)))`);

// --- search engines + start page --------------------------------------------
await C(`bro.getSearch().then(s => bro.setSearch({ ...s, defaultKeyword: 'ddg' }))`);
check('default engine change reaches the omnibox', await waitFor(async () => (await C(`document.getElementById('omnibox').placeholder`)).startsWith('Search DuckDuckGo'), 3000));
await C(`bro.newTab()`);
const startWc = await waitFor(() => M(`const w = E.webContents.getAllWebContents().filter(x => x.getURL().endsWith('start.html') && !x.isLoading()).pop(); return w ? w.id : false`), 60000);
await M(`const w = E.webContents.fromId(${startWc}); await w.executeJavaScript("document.getElementById('q').value='gh electron'; document.getElementById('search-form').requestSubmit()"); return true`);
const ghUrl = await waitFor(() => M(`const u = E.webContents.fromId(${startWc}).getURL(); return u.includes('github.com/search') ? u : false`), 30000);
check('start-page search uses keywords (was hard-wired to Google)', !!ghUrl, String(ghUrl || await M(`return E.webContents.fromId(${startWc}).getURL()`)));
await C(`bro.runCommand('tab.close')`);
await C(`bro.getSearch().then(s => bro.setSearch({ ...s, defaultKeyword: 'g' }))`);

// --- find in page ------------------------------------------------------------
await C(`bro.newTab()`);
await waitFor(() => M(`return E.webContents.getAllWebContents().some(x => x.getURL().endsWith('start.html') && !x.isLoading())`), 60000);
await C(`bro.runCommand('page.find')`);
check('Ctrl+F opens the find bar', await waitFor(() => C(`!document.getElementById('findbar').hidden && document.activeElement.id === 'find-input'`), 5000));
await C(`(() => { const i = document.getElementById('find-input'); i.value = 'screen'; i.dispatchEvent(new Event('input')); })()`);
const count = await waitFor(() => C(`document.getElementById('find-count').textContent || false`), 10000);
check('find shows a match count', /^\d+\/\d+$/.test(String(count)), String(count));
await C(`document.getElementById('find-close').click()`);
check('find bar closes', await C(`document.getElementById('findbar').hidden`));
await C(`bro.runCommand('tab.close')`);

// --- zoom --------------------------------------------------------------------
await C(`bro.runCommand('page.zoomIn')`);
check('zoom badge appears at 110%', await waitFor(() => C(`!document.getElementById('btn-zoom').hidden && document.getElementById('btn-zoom').textContent === '110%'`), 5000));
await C(`document.getElementById('btn-zoom').click()`);
check('clicking the badge resets zoom', await waitFor(() => C(`document.getElementById('btn-zoom').hidden`), 5000));

// --- sessions + library ------------------------------------------------------
await C(`bro.navigate('example.com')`);
await C(`bro.newTab('example.org')`);
await waitFor(() => C(`bro.listTabs().then(t => t.some(x => x.url.includes('example.com')) && t.some(x => x.url.includes('example.org')))`), 30000);
await C(`bro.saveSession('E2E session')`);
const sess = await waitFor(() => C(`bro.getSessions().then(s => s.find(x => x.name === 'E2E session') || false)`), 5000);
check('save session', !!sess && sess.tabs.length >= 2, sess ? `${sess.tabs.length} tabs` : '');
await C(`bro.runCommand('app.history')`);
check('Ctrl+H opens Library on History', await waitFor(() => L(`document.getElementById('tab-history').classList.contains('active')`), 5000));
await L(`document.getElementById('tab-sessions').click()`);
check('Library lists sessions', await waitFor(() => L(`[...document.querySelectorAll('.lib-item-title')].some(e => e.textContent === 'E2E session')`), 5000));
await C(`bro.closeLibrary()`);
const b4 = await tabCount();
await C(`bro.openSession(${JSON.stringify(sess.id)})`);
check('open session restores its tabs', await waitFor(async () => (await tabCount()) === b4 + sess.tabs.length, 10000), `${b4} → ${await tabCount()}`);
await C(`bro.removeSession(${JSON.stringify(sess.id)})`);
await sleep(300);
check('delete session', !(await C(`bro.getSessions().then(s => s.some(x => x.id === ${JSON.stringify(sess.id)}))`)));

// --- reopen closed tab / duplicate -------------------------------------------
const b5 = await tabCount();
await C(`bro.runCommand('tab.close')`); await sleep(300);
await C(`bro.runCommand('tab.reopenClosed')`);
check('reopen closed tab', await waitFor(async () => (await tabCount()) === b5, 5000));

// --- prefs ---------------------------------------------------------------------
await C(`bro.setPrefs({ startup: 'newtab' })`); await sleep(200);
check('startup pref saved', (await C(`bro.getPrefs().then(p => p.startup)`)) === 'newtab');
check('settings radio follows', await waitFor(() => S(`document.querySelector('input[value=newtab]').checked`), 3000));
await C(`bro.setPrefs({ startup: 'restore' })`);

// --- boss key + fullscreen ---------------------------------------------------------
await C(`bro.runCommand('stealth.bossKey')`); await sleep(400);
check('boss key hides the window', (await M(`return E.BrowserWindow.getAllWindows()[0].isVisible()`)) === false);
await C(`bro.runCommand('stealth.bossKey')`); await sleep(400);
check('boss key brings it back', (await M(`return E.BrowserWindow.getAllWindows()[0].isVisible()`)) === true);

// --- adblock retry fix (adblock plugin: adblock:get|set|reload over the bus) ---------
const AB = `bro.plugin.invoke('adblock:get')`;
await waitFor(() => C(`${AB}.then(s => s.ready)`), 120000, 1000);
await C(`bro.plugin.send('adblock:reload')`);
await sleep(500);
const ab = await waitFor(() => C(`${AB}.then(s => !s.loading && s)`), 120000, 1000);
check('adblock Retry reloads cleanly', !!ab && ab.ready && !ab.error, JSON.stringify(ab));
await C(`bro.plugin.send('adblock:set', false)`); await sleep(200);
await C(`bro.plugin.send('adblock:set', false)`); await sleep(200); // used to throw "not enabled"
await C(`bro.plugin.send('adblock:set', true)`); await sleep(200);
check('adblock toggle is idempotent', (await C(`${AB}.then(s => s.enabled && s.ready)`)) === true);

// --- opacity + screen-share hiding over the bus ---------------------------------------
await C(`bro.plugin.send('opacity:set', 0.5)`);
check('opacity:set fades the window', await waitFor(async () => Math.abs((await M(`return E.BrowserWindow.getAllWindows()[0].getOpacity()`)) - 0.5) < 0.02, 5000));
await C(`bro.plugin.send('opacity:nudge', 0.1)`);
const op = await waitFor(async () => { const v = await C(`bro.plugin.invoke('opacity:get')`); return Math.abs(v - 0.6) < 0.02 ? v : false; }, 5000);
check('opacity:nudge steps it', !!op, String(await C(`bro.plugin.invoke('opacity:get')`)));
await C(`bro.plugin.send('opacity:set', 1)`);
await C(`bro.plugin.send('overlay:set', false)`);
check('overlay:set false makes the window capturable', await waitFor(async () => (await C(`bro.plugin.invoke('overlay:get')`)) === false, 5000));
await C(`bro.plugin.send('overlay:set', true)`);
check('…and true hides it again', await waitFor(async () => (await C(`bro.plugin.invoke('overlay:get')`)) === true, 5000));

// --- settings page renders -------------------------------------------------------
// Rows expected: every core command + those of plugins in this build (shared/shortcuts.ts).
const src = readFileSync(new URL('../../src/shared/shortcuts.ts', import.meta.url), 'utf8');
const cmds = [...src.slice(src.indexOf('export const COMMANDS'), src.indexOf('] as const')).matchAll(/^\s*\{ id: '([\w.]+)',[^\n]*?(?:plugin: '([\w-]+)')?[^\n]*\},?$/gm)].map((m) => ({ id: m[1], plugin: m[2] }));
const expectRows = cmds.filter((c) => !c.plugin || plugins.includes(c.plugin)).length;
const userData = await M(`return E.app.getPath('userData')`);
const st = await S(`({ groups: document.querySelectorAll('#sc-groups .sc-group').length, rows: document.querySelectorAll('#sc-groups .sc-row').length, engines: document.querySelectorAll('#engine-table .engine-row:not(.engine-head)').length, dataDir: document.getElementById('data-dir').textContent, hint: document.querySelector('.kbd-for').textContent })`);
check('settings: shortcut editor renders every group + command', st.groups === 6 && st.rows === expectRows, `${JSON.stringify(st)}, expected ${expectRows} rows`);
check('settings: search engine table renders', st.engines >= 12);
check('settings: data folder shown (the BRO_PLUS_CONFIG_DIR folder)', st.dataDir === userData, `${st.dataDir} vs ${userData}`);
check('settings: inline key hint uses live binding', st.hint.includes('Ctrl+Shift+O'), st.hint);

// --- leave two real tabs for the restart test ----------------------------------------
const exc = exceptionsOf(chrome, settings, library);
check('no uncaught exceptions in chrome/settings/library pages', exc.length === 0, exc.join(' | '));
done();
