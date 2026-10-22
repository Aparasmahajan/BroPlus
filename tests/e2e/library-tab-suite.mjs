// Library as a page in a tab (Ctrl+J → bro://downloads, Ctrl+Shift+J → bro://offline) against a running Bro Plus (main :9229).
//   node library-tab-suite.mjs
import { connectMain, chromeEval, checker, waitFor } from './lib.mjs';
const { M } = await connectMain();
const C = await chromeEval(M);
const { check, done } = checker();
const tabs = () => C('bro.listTabs()');
const active = async () => (await tabs()).find((t) => t.active);
/** Run JS in the page of the tab whose address bar shows `addr`. */
const inPage = (urlPart, js) => M(`const w = E.webContents.getAllWebContents().find(w => w.getURL().includes(${JSON.stringify(urlPart)}) && !w.isLoading()); return w ? w.executeJavaScript(${JSON.stringify(js)}) : null`);

// Start without Library tabs (Ctrl+J reuses an open one, as it should).
for (const t of await tabs()) if (t.url.startsWith('bro://')) await C(`bro.closeTab(${t.id})`);
await waitFor(async () => !(await tabs()).some((t) => t.url.startsWith('bro://')));
const n0 = (await tabs()).length;
await C(`bro.runCommand('app.downloads')`);
const dl = await waitFor(async () => { const a = await active(); return a?.url === 'bro://downloads' && a.title === 'Downloads' ? a : false; });
check('Ctrl+J opens Downloads in a new tab (bro://downloads)', !!dl && (await tabs()).length === n0 + 1, dl ? `${dl.url} "${dl.title}"` : JSON.stringify(await active()));
const bridged = await waitFor(() => inPage('library.html?tab', `typeof window.bro === 'object' && document.querySelector('#tab-downloads').classList.contains('active') && document.getElementById('close').hidden`));
check('…the page works there (bridge, Downloads view, no overlay close button)', bridged === true, String(bridged));

await C(`bro.runCommand('app.offline')`);
const off = await waitFor(async () => { const a = await active(); return a?.url === 'bro://offline' && a.title === 'Offline videos' ? a : false; });
check('Ctrl+Shift+J switches the same tab to Offline (no second Library tab)', !!off && (await tabs()).length === n0 + 1 && off.id === dl.id, off ? `${off.url} "${off.title}"` : JSON.stringify(await active()));

await C(`bro.navigate('https://example.com/')`);
const web = await waitFor(async () => { const a = await active(); return a?.url.startsWith('https://example.com') && !a.loading ? a : false; });
check('typing a web address in the Library tab opens it in a normal tab, same place', !!web && (await tabs()).length === n0 + 1 && !(await tabs()).some((t) => t.url.startsWith('bro://')), web?.url);
const leak = await inPage('example.com', `typeof window.bro`);
check('…and that web page has no access to Bro’s bridge', leak === 'undefined', String(leak));

await C(`bro.navigate('bro://offline')`);
const back = await waitFor(async () => { const a = await active(); return a?.url === 'bro://offline' ? a : false; });
const ok2 = back && (await waitFor(() => inPage('library.html?tab', `typeof window.bro === 'object' && document.querySelector('#tab-offline').classList.contains('active')`)));
check('typing bro://offline in a web tab opens the Offline page', ok2 === true);

const snap = await M(`await new Promise(r => setTimeout(r, 1500)); return fs.readFileSync(path.join(E.app.getPath('userData'), 'data', 'session-last.json'), 'utf8')`);
check('saved session remembers it as bro://offline (not a file path)', snap.includes('bro://offline') && !snap.includes('library.html'), snap.slice(0, 200));

done();
