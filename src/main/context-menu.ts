import {
  app,
  clipboard,
  Menu,
  MenuItem,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import type { TabContext } from './tabs';
import type { OfflineWhat, Profile } from '../shared/ipc-contract';

export interface ContextMenuDeps {
  window: BrowserWindow;
  openTab(url: string, opts: { private?: boolean; profileId?: string; background?: boolean }): void;
  saveAs(url: string, wc: WebContents): void;
  saveOffline(wc: WebContents, what: OfflineWhat, mediaUrl?: string): void;
  /** Omnibox resolution (keywords, default engine, bare domains). */
  resolve(text: string): string;
  searchEngineName(): string;
  profiles(): Profile[];
  extensionItems(profileId: string, wc: WebContents, params: ContextMenuParams): MenuItem[];
}

const shorten = (s: string, n = 32) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const looksLikeAddress = (s: string) => !/\s/.test(s) && (/^[a-z][\w+.-]*:\/\//i.test(s) || /^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(s));

/** Chrome-style right-click menu for a web page in a tab. */
export function showTabContextMenu(wc: WebContents, params: ContextMenuParams, ctx: TabContext, deps: ContextMenuDeps): void {
  const items: MenuItemConstructorOptions[] = [];
  const sep = () => items.push({ type: 'separator' });
  const here = { private: ctx.private, profileId: ctx.profileId };
  const link = params.linkURL;
  const src = params.srcURL;
  const selection = params.selectionText.trim();

  if (link) {
    items.push({ label: 'Open link in new tab', click: () => deps.openTab(link, { ...here, background: true }) });
    if (!ctx.private) items.push({ label: 'Open link in private tab', click: () => deps.openTab(link, { private: true }) });
    const others = deps.profiles().filter((p) => ctx.private || p.id !== ctx.profileId);
    if (deps.profiles().length > 1 && others.length) {
      items.push({
        label: 'Open link as',
        submenu: others.map((p) => ({ label: p.name, click: () => deps.openTab(link, { profileId: p.id }) })),
      });
    }
    sep();
    if (/^(https?|data|blob):/i.test(link)) items.push({ label: 'Save link as…', click: () => deps.saveAs(link, wc) });
    items.push({ label: 'Copy link address', click: () => clipboard.writeText(link) });
    sep();
  }

  if (params.mediaType === 'image' && src) {
    items.push(
      { label: 'Open image in new tab', click: () => deps.openTab(src, { ...here, background: true }) },
      { label: 'Save image as…', click: () => deps.saveAs(src, wc) },
      { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(src) },
    );
    sep();
  } else if (params.mediaType === 'video' || params.mediaType === 'audio') {
    const kind = params.mediaType;
    // Streaming players hand the element a blob: URL — the page itself is what can be saved then.
    const direct = !!src && !src.startsWith('blob:');
    items.push({ label: `Save ${kind} for offline`, click: () => deps.saveOffline(wc, 'video', direct ? src : undefined) });
    if (direct) {
      items.push(
        { label: `Open ${kind} in new tab`, click: () => deps.openTab(src, { ...here, background: true }) },
        { label: `Save ${kind} as…`, click: () => deps.saveAs(src, wc) },
        { label: `Copy ${kind} address`, click: () => clipboard.writeText(src) },
      );
    }
    sep();
  }

  if (params.isEditable) {
    editItems(wc, params, items);
  } else if (selection) {
    items.push({ label: 'Copy', click: () => wc.copy() });
    items.push(
      looksLikeAddress(selection)
        ? { label: `Go to ${shorten(selection)}`, click: () => deps.openTab(deps.resolve(selection), here) }
        : {
            label: `Search ${deps.searchEngineName()} for “${shorten(selection)}”`,
            click: () => deps.openTab(deps.resolve(`${selection}`), here),
          },
    );
    sep();
  }

  if (!link && !src && !params.isEditable && !selection) {
    const nav = wc.navigationHistory;
    items.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Reload', click: () => wc.reload() },
    );
    sep();
    const page = wc.getURL();
    if (/^https?:/i.test(page)) {
      items.push({ label: 'Save page + video for offline', click: () => deps.saveOffline(wc, 'page+video') });
      items.push({ label: 'Save page as…', click: () => deps.saveAs(page, wc) });
      items.push({ label: 'View page source', click: () => deps.openTab(`view-source:${page}`, here) });
    }
    items.push({ label: 'Print…', click: () => wc.print() });
    sep();
  }

  const menu = Menu.buildFromTemplate(tidy(items));
  const separator = () => new MenuItem({ type: 'separator' }); // an item can only belong to one menu
  if (menu.items.length) menu.append(separator());
  // Extension items are real MenuItems from the extension system, so they're appended as-is.
  const ext = ctx.private ? [] : deps.extensionItems(ctx.profileId, wc, params);
  for (const item of ext) menu.append(item);
  if (ext.length) menu.append(separator());
  menu.append(new MenuItem({ label: 'Inspect', click: () => inspect(wc, params) }));
  menu.popup({ window: deps.window });
}

/** Bro's own pages (address bar, Settings, Library): just the editing menu. */
export function showUiContextMenu(wc: WebContents, params: ContextMenuParams, window: BrowserWindow): void {
  const items: MenuItemConstructorOptions[] = [];
  if (params.isEditable) editItems(wc, params, items);
  else if (params.selectionText.trim()) items.push({ label: 'Copy', click: () => wc.copy() });
  if (!app.isPackaged) items.push({ type: 'separator' }, { label: 'Inspect', click: () => inspect(wc, params) });
  const clean = tidy(items);
  if (clean.length) Menu.buildFromTemplate(clean).popup({ window });
}

function editItems(wc: WebContents, params: ContextMenuParams, items: MenuItemConstructorOptions[]): void {
  const f = params.editFlags;
  const suggestions = params.dictionarySuggestions.slice(0, 5);
  for (const s of suggestions) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
  if (params.misspelledWord) {
    if (!suggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({
      label: 'Add to dictionary',
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: 'separator' });
  }
  items.push(
    { label: 'Undo', enabled: f.canUndo, click: () => wc.undo() },
    { label: 'Redo', enabled: f.canRedo, click: () => wc.redo() },
    { type: 'separator' },
    { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
    { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
    { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
    { label: 'Paste as plain text', enabled: f.canPaste, click: () => wc.pasteAndMatchStyle() },
    { label: 'Select all', enabled: f.canSelectAll, click: () => wc.selectAll() },
    { type: 'separator' },
  );
}

function inspect(wc: WebContents, params: ContextMenuParams): void {
  wc.inspectElement(params.x, params.y);
  if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus();
}

/** No separators at the ends or twice in a row. */
function tidy(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const it of items) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}
