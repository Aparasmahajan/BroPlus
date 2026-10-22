// Regression for "Cannot read properties of undefined (reading 'isDestroyed')": tabs whose page dies on its own.
// Against a running Bro Plus (main :9229).
import { connectMain, chromeEval, checker } from './lib.mjs';
const { M } = await connectMain();
await chromeEval(M);
const { check, done } = checker();

const res = await M(`
  const errs = []; process.on('uncaughtException', (e) => errs.push(String(e && e.stack || e).split('\\n').slice(0, 3).join(' | ')));
  const chrome = E.webContents.getAllWebContents().find(w => w.getURL().endsWith('dist/ui/index.html'));
  const tabs = () => chrome.executeJavaScript('bro.listTabs()');
  const res = {};
  const waitTab = async (pred, loaded = true) => { for (let i = 0; i < 600; i++) { const w = E.webContents.getAllWebContents().find(pred); if (w && (!loaded || !w.isLoading())) return w; await wait(250); } };

  // 1) The exact crash: close a tab's page from outside, then open a new tab.
  const n0 = (await tabs()).length;
  let before = new Set(E.webContents.getAllWebContents().map(w => w.id));
  await chrome.executeJavaScript("bro.newTab('example.com')");
  const victim = await waitTab(w => !before.has(w.id) && w.getURL().includes('example.com'));
  victim.close();
  await wait(1500);
  await chrome.executeJavaScript('bro.newTab()');
  await wait(2500);
  res.outsideClose = { tabsBefore: n0, tabsAfter: (await tabs()).length, expected: n0 + 1 };

  // 2) A private popup that closes itself.
  before = new Set(E.webContents.getAllWebContents().map(w => w.id));
  await chrome.executeJavaScript("bro.runCommand('tab.newPrivate')");
  const PS = E.session.fromPartition('bro-private');
  const priv = await waitTab(w => !before.has(w.id) && w.session === PS, false); // its start page can take minutes on a cold profile
  if (!priv) { res.uncaught = errs; res.error = 'private tab never appeared'; return res; }
  await priv.loadURL('https://example.com/');
  const n1 = (await tabs()).length;
  before = new Set(E.webContents.getAllWebContents().map(w => w.id));
  await priv.executeJavaScript("window.open('https://example.org/')", true);
  const popup = await waitTab(w => !before.has(w.id) && w.session === PS && w.getURL().includes('example.org'));
  const n2 = (await tabs()).length;
  await popup.executeJavaScript('window.close()', true);
  await wait(2500);
  res.selfClosingPrivatePopup = { tabsBefore: n1, withPopup: n2, afterClose: (await tabs()).length };
  await chrome.executeJavaScript('bro.newTab()'); await wait(1500);
  res.listStillWorks = Array.isArray(await tabs());
  res.uncaught = errs;
  return res;`);
console.log(JSON.stringify(res, null, 1));

const o = res.outsideClose, p = res.selfClosingPrivatePopup ?? {};
if (res.error) check(res.error, false);
check('a tab whose page was closed from outside drops out of the list; new tabs still open', o.tabsAfter === o.expected, JSON.stringify(o));
check('a self-closing private popup opens as a tab…', p.withPopup === p.tabsBefore + 1, JSON.stringify(p));
check('…and its tab goes away when it closes itself', p.afterClose === p.tabsBefore, JSON.stringify(p));
check('the tab list still answers afterwards', res.listStillWorks === true);
check('no uncaught exceptions in the main process', res.uncaught.length === 0, res.uncaught.join(' || '));
done();
