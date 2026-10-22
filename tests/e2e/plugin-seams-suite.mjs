// The seams between the core browser and its build-time plugins, against a running Bro Plus
// (main :9229, pages :9333). Fresh launch per variant.
//   node plugin-seams-suite.mjs full           — default build (plugins.config.json: every plugin)
//   node plugin-seams-suite.mjs browser-only   — built with BRO_PLUGINS=overlay-hiding,opacity
//                                                (run-all.mjs builds that variant into tests/e2e/.builds)
import { connectMain, page, waitFor, sleep, checker, exceptionsOf } from './lib.mjs';
const variant = process.argv[2] || 'full';
if (!['full', 'browser-only'].includes(variant)) throw new Error('variant: full | browser-only');

const { M } = await connectMain();
await waitFor(() => M(`return E.BrowserWindow.getAllWindows().some(w => w.isVisible())`), 120000);
const chrome = await page('dist/ui/index.html');
const settings = await page('settings.html');
const C = (e) => chrome.evaluate(e);
const S = (e) => settings.evaluate(e);
const { check, done } = checker();

const ids = await waitFor(async () => (await C(`bro.activePlugins()`)).map((p) => p.id), 30000);
/** Mode as the chrome sees it (body[data-mode] follows onModeChanged; unset = never left Browse). */
const mode = () => C(`document.body.dataset.mode || 'browse'`);
/** Plugin panel views (WebContentsViews loading dist/ui/<plugin>.html) and whether each is showing. */
const panels = () => M(`const win = E.BrowserWindow.getAllWindows()[0];
  const kids = win.contentView.children;
  return kids.filter(v => v.webContents && /dist\\/ui\\/(api-client|proxy)\\.html$/.test(v.webContents.getURL()))
    .map(v => ({ html: v.webContents.getURL().split('/').pop(), visible: v.getVisible(), top: kids.indexOf(v) === kids.length - 1 }));`);
const panel = async (html) => (await panels()).find((p) => p.html === html);
const tabs = () => C(`bro.listTabs()`);

if (variant === 'full') {
  check('full build ships every plugin', ['overlay-hiding', 'opacity', 'api-client', 'proxy', 'diff', 'adblock'].every((i) => ids.includes(i)), ids.join(','));

  // --- mode switch is built from the surfaces in this build ---------------------------
  const btns = await waitFor(() => C(`(() => { const s = document.getElementById('mode-switch'); return !s.hidden && [...s.querySelectorAll('.mode-btn')].map(b => b.dataset.mode + (b.classList.contains('active') ? '*' : '')).join(',') })()`), 10000);
  check('mode switch shows Browse + API + Proxy, Browse active', btns === 'browse*,api,proxy', String(btns));
  check('no panel exists before its first use', (await panels()).length === 0, JSON.stringify(await panels()));

  // --- switching modes shows/hides panels ----------------------------------------------
  await C(`document.querySelector('#mode-switch .mode-btn[data-mode=api]').click()`);
  const api = await waitFor(async () => { const p = await panel('api-client.html'); return p?.visible && (await mode()) === 'api' ? p : false; }, 30000);
  check('clicking API switches mode and shows the API panel on top', !!api && api.top, JSON.stringify(await panels()));
  check('…the mode button follows', (await C(`document.querySelector('#mode-switch .mode-btn.active').dataset.mode`)) === 'api');
  const apiBridge = await waitFor(() => M(`const w = E.webContents.getAllWebContents().find(w => w.getURL().endsWith('dist/ui/api-client.html') && !w.isLoading()); return w ? w.executeJavaScript('typeof window.bro.plugin.invoke') : false`), 30000);
  check('…and the panel has the plugin bus', apiBridge === 'function', String(apiBridge));

  await C(`bro.setMode('proxy')`);
  const sw = await waitFor(async () => { const [a, p] = [await panel('api-client.html'), await panel('proxy.html')]; return p?.visible && !a?.visible && (await mode()) === 'proxy' ? { a, p } : false; }, 30000);
  check('bro.setMode("proxy") shows Proxy and hides API', !!sw, JSON.stringify(await panels()));

  await C(`bro.setMode('browse')`);
  check('back to Browse hides every panel', await waitFor(async () => (await mode()) === 'browse' && (await panels()).every((p) => !p.visible), 10000), JSON.stringify(await panels()));

  await C(`bro.setMode('no-such-mode')`);
  await sleep(800);
  check('an unknown mode is ignored', (await mode()) === 'browse' && (await panels()).every((p) => !p.visible));

  // --- browsing actions bring the tabs back -----------------------------------------------
  const t = await tabs();
  await C(`bro.setMode('api')`);
  await waitFor(async () => (await mode()) === 'api', 10000);
  await C(`bro.activateTab(${t.find((x) => x.active).id})`);
  check('activating a tab returns to Browse', await waitFor(async () => (await mode()) === 'browse' && !(await panel('api-client.html')).visible, 10000), `${await mode()} ${JSON.stringify(await panels())}`);

  await C(`bro.setMode('proxy')`);
  await waitFor(async () => (await mode()) === 'proxy', 10000);
  const n = (await tabs()).length;
  await C(`bro.newTab()`);
  check('opening a new tab returns to Browse too', await waitFor(async () => (await mode()) === 'browse' && (await tabs()).length === n + 1 && !(await panel('proxy.html')).visible, 15000), await mode());
  await C(`bro.runCommand('tab.close')`);

  // --- capability plugins show up in the chrome + Settings ---------------------------------
  check('shield counter is shown (adblock)', await waitFor(() => C(`!document.getElementById('shield').hidden`), 10000));
  const rows = await S(`['row-capture', 'row-adblock', 'row-opacity'].map(id => id + ':' + !document.getElementById(id).classList.contains('plugin-off')).join(',')`);
  check('Settings shows screen-share, ad blocking and opacity rows', rows === 'row-capture:true,row-adblock:true,row-opacity:true', rows);
} else {
  check('browser-only build ships just overlay-hiding + opacity', ids.join(',') === 'overlay-hiding,opacity', ids.join(','));

  // --- no surfaces → no mode switch; setMode can't reach a missing plugin -----------------
  const ms = await C(`(() => { const s = document.getElementById('mode-switch'); return { hidden: s.hidden, shown: s.offsetWidth > 0, modes: [...s.querySelectorAll('.mode-btn')].map(b => b.dataset.mode) }; })()`);
  check('mode switch is hidden (no surface besides Browse)', ms.hidden && !ms.shown && ms.modes.every((m) => m === 'browse'), JSON.stringify(ms));
  await C(`bro.setMode('api')`);
  await sleep(1500);
  check('bro.setMode("api") does nothing (no API plugin in this build)', (await mode()) === 'browse' && !(await M(`return E.webContents.getAllWebContents().some(w => /api-client|proxy\\.html/.test(w.getURL()))`)));

  // --- no adblock → no shield, no Settings row, no channel, nothing on the sessions -------
  await sleep(2000); // the chrome wires the shield once activePlugins() answers
  check('shield counter stays hidden', await C(`document.getElementById('shield').hidden`));
  const rows = await S(`['row-capture', 'row-adblock', 'row-opacity'].map(id => id + ':' + !document.getElementById(id).classList.contains('plugin-off')).join(',')`);
  check('Settings hides the ad-blocking row, keeps screen-share + opacity', rows === 'row-capture:true,row-adblock:false,row-opacity:true', rows);
  const ab = await C(`bro.plugin.invoke('adblock:get').then(() => 'answered', e => e.message)`);
  check('adblock:get has no handler', /No handler registered/.test(ab), ab);
  const pre = await M(`return E.session.defaultSession.getPreloadScripts().map(p => p.filePath.split(/[\\\\/]/).pop())`);
  check('no ad-block / YouTube-shield preload on the browsing session', !pre.some((p) => /adblock/.test(p)), JSON.stringify(pre));

  // --- the plugins that are in still work -------------------------------------------------
  check('overlay:get answers (hidden from capture by default)', (await C(`bro.plugin.invoke('overlay:get')`)) === true);
  await C(`bro.plugin.send('opacity:set', 0.7)`);
  check('opacity:set still fades the window', await waitFor(async () => Math.abs((await M(`return E.BrowserWindow.getAllWindows()[0].getOpacity()`)) - 0.7) < 0.02, 5000));
  await C(`bro.plugin.send('opacity:set', 1)`);
  check('the screen-share hotkey is registered', (await M(`return E.globalShortcut.isRegistered('CommandOrControl+Shift+H')`)) === true);
}

const exc = exceptionsOf(chrome, settings);
check('no uncaught exceptions in chrome/settings', exc.length === 0, exc.join(' | '));
done();
