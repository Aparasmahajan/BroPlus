// End-to-end checks for private tabs against a running Bro Plus (main :9229, pages :9333). Fresh launch.
import { connectMain, page, waitFor, sleep, checker, exceptionsOf } from './lib.mjs';

const { M: M0 } = await connectMain();
const M = (code) => M0(`const PS = E.session.fromPartition('bro-private'); ${code}`);
await waitFor(() => M(`return E.BrowserWindow.getAllWindows().some(w => w.isVisible())`), 120000);
await sleep(8000); // let startup settle on this machine
const chrome = await page('dist/ui/index.html');
const settings = await page('settings.html');
const C = (e) => chrome.evaluate(e);
const { check, done } = checker();
const tabs = () => C(`bro.listTabs()`);
const privWcs = `E.webContents.getAllWebContents().filter(w => w.session === PS)`;
const histLen = () => C(`bro.getHistory().then(h => h.length)`);
const AB = `bro.plugin.invoke('adblock:get')`; // ad blocking is the adblock plugin, reached over the bus

const hist0 = await histLen();
const n0 = (await tabs()).length;

// --- open with the real key -------------------------------------------------------
await M(`const wc = E.webContents.getAllWebContents().find(w => w.getURL().endsWith('dist/ui/index.html')); wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control', 'shift'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control', 'shift'] }); return true`);
check('Ctrl+Shift+N opens a tab', await waitFor(async () => (await tabs()).length === n0 + 1, 15000));
const t1 = (await tabs()).find((t) => t.active);
check('…that is private and active', !!t1?.private, JSON.stringify(t1 && { id: t1.id, private: t1.private }));
check('private tab uses the in-memory session', await waitFor(() => M(`const w = ${privWcs}; return w.length === 1 && !PS.isPersistent() && w[0].session !== E.session.defaultSession`), 10000));
check('chrome shows Private badge + tab marking', await waitFor(() => C(`!document.getElementById('private-badge').hidden && document.body.classList.contains('private-active') && document.querySelectorAll('#tabs .tab.private').length === 1`), 10000));
const note = await waitFor(() => M(`const w = ${privWcs}[0]; if (w.isLoading()) return false; return w.executeJavaScript("!document.getElementById('private-note').hidden")`), 60000);
check('private start page shows the private notice', note === true);
check('ad blocking is attached to the private session', (await M(`return PS.getPreloadScripts().length`)) > 0, `${await M(`return PS.getPreloadScripts().length`)} preload script(s)`);

// --- browse privately --------------------------------------------------------------------
await C(`bro.navigate('example.com/?bro-private-test=1')`);
const loaded = await waitFor(() => M(`const w = ${privWcs}[0]; return !w.isLoading() && w.getURL().includes('bro-private-test') ? w.getURL() : false`), 60000);
check('private tab navigates', !!loaded, String(loaded));
await M(`await ${privWcs}[0].executeJavaScript("document.cookie = 'brotest=1; max-age=3600'"); return true`);
await sleep(500);
const ck = await M(`return [(await PS.cookies.get({ name: 'brotest' })).length, (await E.session.defaultSession.cookies.get({ name: 'brotest' })).length]`);
check('cookie lands in the private session only', ck[0] === 1 && ck[1] === 0, JSON.stringify(ck));
// Ads are really blocked in the private session (network level, not just the preload).
await waitFor(() => C(`${AB}.then(s => s.ready)`), 120000, 1000);
// Compare the same ad script with blocking on vs off (proves it's Bro blocking, not the network).
const loadAd = () => M(`return ${privWcs}[0].executeJavaScript("new Promise(res => { const s = document.createElement('script'); s.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js?x=' + Math.random(); s.onload = () => res('loaded'); s.onerror = () => res('blocked'); document.head.appendChild(s); })")`);
const on1 = await loadAd();
await C(`bro.plugin.send('adblock:set', false)`); await sleep(500);
const off = await loadAd();
await C(`bro.plugin.send('adblock:set', true)`); await sleep(500);
const on2 = await loadAd();
check('ad script blocked in a private tab (loads when blocking is off)', on1 === 'blocked' && off === 'loaded', `on: ${on1}, off: ${off}`);
check('…and blocked again after turning blocking back on', on2 === 'blocked', on2);

await sleep(1000);
check('no history recorded for private browsing', (await histLen()) === hist0 && !(await C(`bro.getHistory().then(h => h.some(x => x.url.includes('bro-private-test')))`)));

// Links opened from a private page stay private.
const nBefore = (await tabs()).length;
await M(`await ${privWcs}[0].executeJavaScript("window.open('https://example.org/?bro-private-popup=1')", true); return true`);
check('window.open from a private tab opens a private tab', await waitFor(async () => { const t = await tabs(); return t.length === nBefore + 1 && t.filter((x) => x.private).length === 2; }, 20000));

// Never saved: last-session snapshot + named sessions.
await C(`bro.saveSession('private-test-session')`);
const saved = await waitFor(() => C(`bro.getSessions().then(s => s.find(x => x.name === 'private-test-session') || 'none')`), 3000);
const leaked = saved !== 'none' && saved.tabs.some((t) => t.url.includes('bro-private'));
check('saved sessions exclude private tabs', !leaked, saved === 'none' ? 'nothing saved (only private/start tabs open)' : `${saved.tabs.length} normal tab(s) saved`);
if (saved !== 'none') await C(`bro.removeSession(${JSON.stringify(saved.id)})`);
await sleep(800);
const last = await M(`return fs.readFileSync(path.join(E.app.getPath('userData'), 'data', 'session-last.json'), 'utf8')`);
check('autosaved last session excludes private tabs', !last.includes('bro-private'));

// Duplicate keeps private.
await C(`bro.runCommand('tab.duplicate')`);
check('duplicating a private tab stays private', await waitFor(async () => (await tabs()).filter((x) => x.private).length === 3, 20000));

// --- normal tab next to it ---------------------------------------------------------------------
await C(`bro.newTab()`);
await sleep(500);
check('switching to a normal tab drops the private look', await waitFor(() => C(`document.getElementById('private-badge').hidden && !document.body.classList.contains('private-active')`), 10000));

// --- close every private tab → wiped -----------------------------------------------------------------
const privIds = (await tabs()).filter((t) => t.private).map((t) => t.id);
for (const id of privIds) { await C(`bro.closeTab(${id})`); await sleep(300); }
check('all private tabs closed', await waitFor(async () => (await tabs()).every((t) => !t.private), 10000));
const wiped = await waitFor(async () => (await M(`return (await PS.cookies.get({})).length`)) === 0, 15000);
check('closing the last private tab wipes private cookies', !!wiped, `${await M(`return (await PS.cookies.get({})).length`)} cookie(s) left`);
const nAfterClose = (await tabs()).length;
await C(`bro.runCommand('tab.reopenClosed')`);
await sleep(1500);
const reopened = await tabs();
check('Reopen-closed-tab cannot bring a private tab back afterwards', !reopened.some((t) => t.private) && !(await M(`return E.webContents.getAllWebContents().some(w => w.getURL().includes('bro-private'))`)), `${nAfterClose} → ${reopened.length} tabs`);

// --- settings + menu ------------------------------------------------------------------------------
const row = await settings.evaluate(`[...document.querySelectorAll('#sc-groups .sc-row')].some(r => r.textContent.includes('New private tab') && r.textContent.includes('Ctrl+Shift+N'))`);
check('Settings lists the rebindable "New private tab" shortcut', row);
const menu = await M(`return E.Menu.getApplicationMenu().items.find(i => i.label === 'File').submenu.items.some(i => i.label === 'New Private Tab' && i.accelerator === 'CommandOrControl+Shift+N')`);
check('File menu has New Private Tab', menu);
check('history still unchanged at the end', !(await C(`bro.getHistory().then(h => h.some(x => x.url.includes('bro-private')))`)));
const exc = exceptionsOf(chrome, settings);
check('no uncaught exceptions in chrome/settings', exc.length === 0, exc.join(' | '));
done();
