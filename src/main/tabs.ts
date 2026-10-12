import { WebContentsView, type BrowserWindow, type WebContents, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Event, type TabState } from '../shared/ipc-contract';

const START_PAGE = join(__dirname, '../ui/start.html');
// pathToFileURL handles Windows drive letters → file:///C:/... correctly.
const START_URL = pathToFileURL(START_PAGE).href;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Tab {
  id: number;
  view: WebContentsView;
  favicon?: string;
}

/** Turn whatever the user typed into a navigable URL. */
export function resolveInput(raw: string): string {
  const input = raw.trim();
  if (!input) return START_URL;
  if (/^(https?|file|about):/i.test(input)) return input;
  // Looks like a host/domain (has a dot, no spaces) or localhost → treat as URL.
  const looksLikeUrl = /^[^\s]+\.[^\s]+$/.test(input) || /^localhost(:\d+)?/.test(input);
  if (looksLikeUrl) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/**
 * Creates, destroys and lays out browser tabs. Each tab is a fully isolated
 * Chromium WebContentsView (same process-isolation model as a Chrome tab).
 * Web content gets NO privileged preload — only the trusted chrome/settings
 * views do.
 */
export class TabManager {
  private tabs: Tab[] = [];
  private activeId = -1;
  private nextId = 1;

  constructor(
    private win: BrowserWindow,
    private region: () => Rect,
    private emit: (channel: string, payload: unknown) => void,
  ) {}

  get activeView(): WebContentsView | undefined {
    return this.tabs.find((t) => t.id === this.activeId)?.view;
  }

  newTab(url?: string): number {
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const id = this.nextId++;
    const tab: Tab = { id, view };
    this.tabs.push(tab);
    this.win.contentView.addChildView(view);

    this.wire(tab);
    void view.webContents.loadURL(url ? resolveInput(url) : START_URL);

    this.activate(id);
    return id;
  }

  closeTab(id: number): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [tab] = this.tabs.splice(idx, 1);
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();

    if (this.activeId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1];
      if (next) this.activate(next.id);
      else this.newTab(); // never leave zero tabs
    } else {
      this.emitChanged();
    }
  }

  activate(id: number): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.activeId = id;
    this.layout();
    this.emitChanged();
  }

  navigate(input: string, id?: number): void {
    const view = this.viewFor(id);
    if (view) void view.webContents.loadURL(resolveInput(input));
  }

  back(id?: number): void {
    const wc = this.viewFor(id)?.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(id?: number): void {
    const wc = this.viewFor(id)?.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(id?: number): void {
    this.viewFor(id)?.webContents.reload();
  }

  stop(id?: number): void {
    this.viewFor(id)?.webContents.stop();
  }

  /** Reposition the active view; hide the rest. */
  layout(): void {
    const r = this.region();
    for (const tab of this.tabs) {
      const isActive = tab.id === this.activeId;
      tab.view.setVisible(isActive);
      if (isActive) {
        this.win.contentView.addChildView(tab.view); // raise to top of tab stack
        tab.view.setBounds(r);
      }
    }
  }

  list(): TabState[] {
    return this.tabs.map((t) => this.stateOf(t));
  }

  // --- internals -----------------------------------------------------------

  private viewFor(id?: number): WebContentsView | undefined {
    if (id == null) return this.activeView;
    return this.tabs.find((t) => t.id === id)?.view;
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    const changed = () => this.emitChanged();

    wc.on('page-title-updated', changed);
    wc.on('did-navigate', changed);
    wc.on('did-navigate-in-page', changed);
    wc.on('did-start-loading', changed);
    wc.on('did-stop-loading', changed);
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons[0];
      changed();
    });

    // target=_blank / window.open → open as a new tab instead of a popup.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.newTab(url);
      else void shell.openExternal(url); // mailto:, etc.
      return { action: 'deny' };
    });
  }

  private stateOf(tab: Tab): TabState {
    const wc = tab.view.webContents;
    const url = wc.getURL();
    const isStart = url.startsWith('file://') && url.includes('start.html');
    return {
      id: tab.id,
      title: isStart ? 'New Tab' : wc.getTitle() || 'Loading…',
      url: isStart ? '' : url,
      active: tab.id === this.activeId,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      favicon: tab.favicon,
    };
  }

  private emitChanged(): void {
    this.emit(Event.TabsChanged, this.list());
  }
}

export type { WebContents };
