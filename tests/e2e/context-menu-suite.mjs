// Right-click menu checks against a running Bro Plus (main inspector :9229).
// Native menus can't be clicked by automation, so Menu.prototype.popup is
// intercepted in the main process: we read the items and call their click().
import { connectMain, chromeEval, checker } from './lib.mjs';
const { M } = await connectMain();
await chromeEval(M);
const { check, done } = checker();

await M(`
  globalThis.__menus = [];
  E.Menu.prototype.popup = function () { globalThis.__menus.push(this); };
  const chrome = E.webContents.getAllWebContents().find(w => w.getURL().endsWith('dist/ui/index.html'));
  globalThis.__chrome = chrome;
  globalThis.__tab = async (cmd, match) => {
    const before = new Set(E.webContents.getAllWebContents().map(w => w.id));
    await chrome.executeJavaScript(cmd);
    for (let i = 0; i < 400; i++) { const w = E.webContents.getAllWebContents().find(x => !before.has(x.id) && (!match || x.getURL().includes(match))); if (w && !w.isLoading()) return w; await wait(250); }
  };
  globalThis.__params = (wc, o) => Object.assign({ x: 40, y: 40, frame: null, linkURL: '', linkText: '', pageURL: wc.getURL(), frameURL: '', srcURL: '', mediaType: 'none',
    hasImageContents: false, isEditable: false, selectionText: '', titleText: '', altText: '', suggestedFilename: '', selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0, referrerPolicy: { policy: 'default', url: '' }, misspelledWord: '', dictionarySuggestions: [], frameCharset: 'UTF-8', inputFieldType: 'none',
    spellcheckEnabled: false, menuSourceType: 'mouse', mediaFlags: {}, editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false } }, o);
  globalThis.__open = (wc, o) => { const n = globalThis.__menus.length; wc.emit('context-menu', { preventDefault() {}, sender: wc }, globalThis.__params(wc, o)); const m = globalThis.__menus[n]; return m; };
  globalThis.__labels = (m) => m ? m.items.map(i => i.type === 'separator' ? '—' : i.label + (i.enabled === false ? ' (off)' : '') + (i.submenu ? ' ▸[' + i.submenu.items.map(s => s.label).join('|') + ']' : '')) : null;
  return true;`);

// A normal tab on a real page.
await M(`globalThis.__wc = await globalThis.__tab("bro.newTab('example.com')", 'example.com'); return !!globalThis.__wc`);

// 1. Real right-click (OS input) reaches Bro's menu.
const real = await M(`const wc = globalThis.__wc; const n = globalThis.__menus.length; wc.focus();
  for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: 200, y: 200, button: 'right', clickCount: 1 });
  for (let i = 0; i < 40 && globalThis.__menus.length === n; i++) await wait(100);
  return globalThis.__labels(globalThis.__menus[n]);`);
check('a real right-click on a page opens Bro\'s menu', Array.isArray(real) && real.includes('Back (off)') && real.includes('Inspect'), JSON.stringify(real));

// 2. Link menu.
const link = await M(`return globalThis.__labels(globalThis.__open(globalThis.__wc, { linkURL: 'https://example.org/?ctx=1', linkText: 'x' }))`);
check('link menu: open in new tab / private tab / save as / copy address', ['Open link in new tab', 'Open link in private tab', 'Save link as…', 'Copy link address', 'Inspect'].every((l) => link.includes(l)), JSON.stringify(link));
const priv = await M(`const m = globalThis.__open(globalThis.__wc, { linkURL: 'https://example.org/?ctx=private' });
  const before = new Set(E.webContents.getAllWebContents().map(w => w.id));
  m.items.find(i => i.label === 'Open link in private tab').click();
  for (let i = 0; i < 200; i++) { const w = E.webContents.getAllWebContents().find(x => !before.has(x.id)); if (w) return { private: w.session === E.session.fromPartition('bro-private') }; await wait(100); }
  return null;`);
check('…"Open link in private tab" opens it in the private session', priv?.private === true);
const copied = await M(`const m = globalThis.__open(globalThis.__wc, { linkURL: 'https://example.org/?ctx=copy' }); m.items.find(i => i.label === 'Copy link address').click(); return E.clipboard.readText()`);
check('…"Copy link address" copies it', copied === 'https://example.org/?ctx=copy', copied);

// 3. Image menu.
const img = await M(`return globalThis.__labels(globalThis.__open(globalThis.__wc, { mediaType: 'image', srcURL: 'https://example.org/pic.png', hasImageContents: true }))`);
check('image menu: open / save / copy image / copy address', ['Open image in new tab', 'Save image as…', 'Copy image', 'Copy image address'].every((l) => img.includes(l)), JSON.stringify(img));

// 4. Selected text → search with the default engine.
const sel = await M(`const m = globalThis.__open(globalThis.__wc, { selectionText: 'bro browser test' });
  const labels = globalThis.__labels(m);
  const item = m.items.find(i => /^Search .* for/.test(i.label));
  const before = new Set(E.webContents.getAllWebContents().map(w => w.id));
  item.click();
  for (let i = 0; i < 200; i++) { const w = E.webContents.getAllWebContents().find(x => !before.has(x.id) && x.getURL()); if (w) return { labels, url: w.getURL() }; await wait(100); }
  return { labels };`);
check('selection menu: Copy + "Search … for “…”" opens a search tab', sel.labels.includes('Copy') && /q=bro(\+|%20)browser(\+|%20)test/.test(sel.url ?? ''), `${JSON.stringify(sel.labels)} → ${sel.url}`);
const addr = await M(`return globalThis.__labels(globalThis.__open(globalThis.__wc, { selectionText: 'github.com/electron' }))`);
check('a selected address offers "Go to …"', addr.some((l) => l.startsWith('Go to github.com/electron')), JSON.stringify(addr));

// 5. Editable field.
const edit = await M(`return globalThis.__labels(globalThis.__open(globalThis.__wc, { isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help'] }))`);
check('text field menu: suggestions, add to dictionary, undo…select all', ['hello', 'help', 'Add to dictionary', 'Undo', 'Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all'].every((l) => edit.includes(l)), JSON.stringify(edit));

// 6. Page menu.
const page = await M(`return globalThis.__labels(globalThis.__open(globalThis.__wc, {}))`);
check('page menu: back/forward/reload, save page, view source, print', ['Reload', 'Save page as…', 'View page source', 'Print…', 'Inspect'].every((l) => page.includes(l)), JSON.stringify(page));
check('no separators at the start/end or doubled', page[0] !== '—' && page.at(-1) !== '—' && !page.join(',').includes('—,—'));

// 7. In a private tab: no "open in private tab", no extension items.
const pmenu = await M(`const w = await globalThis.__tab("bro.runCommand('tab.newPrivate')"); await w.loadURL('https://example.com/').catch(() => {});
  for (let i = 0; i < 200 && w.isLoading(); i++) await wait(100);
  return globalThis.__labels(globalThis.__open(w, { linkURL: 'https://example.org/' }))`);
check('private tab menu has no "Open link in private tab"', !pmenu.includes('Open link in private tab') && pmenu.includes('Open link in new tab'), JSON.stringify(pmenu));

// 8. Bro's own address bar: editing menu only.
const ui = await M(`const n = globalThis.__menus.length; globalThis.__chrome.emit('context-menu', { preventDefault() {} }, globalThis.__params(globalThis.__chrome, { isEditable: true })); return globalThis.__labels(globalThis.__menus[n])`);
check('address bar right-click shows the editing menu', Array.isArray(ui) && ui.includes('Paste') && !ui.includes('Reload'), JSON.stringify(ui));

done();
