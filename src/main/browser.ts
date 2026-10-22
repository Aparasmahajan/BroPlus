import { Menu, WebContentsView, session, shell, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import type { MainWindow } from './window';
import { CHROME_H } from './window';
import { TabManager, type TabSessions } from './tabs';
import { Library } from './library';
import { Extensions } from './extensions';
import { JsonStore } from './store';
import { Sessions } from './sessions';
import { SearchSettings } from './search';
import { ShortcutManager } from './shortcuts';
import { commandHandlers } from './commands';
import { Profiles, DEFAULT_PROFILE } from './profiles';
import { DownloadManager } from './downloads';
import { OfflineManager } from './offline';
import { VideoTools } from './video-tools';
import { showTabContextMenu, showUiContextMenu } from './context-menu';
import { Event, type FindPayload, type LibraryView, type OfflineWhat, type Prefs, type ProfilesState } from '../shared/ipc-contract';
import { commandAvailable, type CustomShortcut } from '../shared/shortcuts';
import type { SessionInfo, SurfaceSpec } from '../core/plugin';

const BRIDGE_PRELOAD = join(__dirname, '../preload/bridge.js');
const CHROME_PRELOAD = join(__dirname, '../preload/chrome.js'); // bridge + extension toolbar
const CHROME_HTML = join(__dirname, '../ui/index.html');
const SETTINGS_HTML = join(__dirname, '../ui/settings.html');
const LIBRARY_HTML = join(__dirname, '../ui/library.html');
const UI_DIR = join(__dirname, '../ui');
/** Commands whose keys a plugin panel keeps for itself (see ShortcutManager.attach). */
const PANEL_KEEPS = ['page.saveOffline', 'page.find', 'page.findNext', 'page.findPrev', 'page.print', 'page.viewSource', 'app.bookmark'] as const;
/** No "persist:" prefix → Chromium keeps it in memory only; nothing reaches disk. */
const PRIVATE_PARTITION = 'bro-private';

/** A plugin surface (API, Proxy): its panel view is created on first switch. */
interface Surface {
  spec: SurfaceSpec;
  view?: WebContentsView;
}

const DEFAULT_PREFS: Prefs = {
  startup: 'restore',
  downloadDir: '',
  askWhereToSave: false,
  downloadConnections: 8,
  maxDownloads: 4,
  torrents: true,
  videoQuality: 720,
  videoSubtitles: true,
};
/** "Save for offline" quality choices: max height, 0 = best, -1 = audio only. */
const VIDEO_QUALITIES: [number, string][] = [
  [360, '360p — smallest, fine for slides and talks'],
  [480, '480p'],
  [720, '720p HD'],
  [1080, '1080p Full HD'],
  [0, 'Best available (biggest)'],
  [-1, 'Audio only — least data'],
];

/**
 * Assembles the browser window: a top chrome bar (tabs + toolbar + mode
 * switch), the tab content area below it, two full-area overlays (Settings,
 * Library) that slide over the tabs on demand, and zero-or-more PLUGIN
 * SURFACES (API, Proxy) registered at boot. Exactly one surface is visible at a
 * time — 'browse' shows the tabs; any other mode shows that plugin's panel
 * over the tab region. Only the chrome, overlay and panel views get the
 * privileged preload; web content (tabs) does not.
 */
export class Browser {
  private readonly chrome: WebContentsView;
  private readonly settings: WebContentsView;
  private readonly libraryView: WebContentsView;
  private readonly overlays: WebContentsView[];
  private readonly prefs: JsonStore<Prefs>;
  private readonly libraries = new Map<string, Library>();
  /** Sessions already given ad blocking, downloads (and extensions, per profile). */
  private readonly wired = new Set<Session>();
  private readonly privateSession: Session;
  /** Plugin hooks run for every session tabs use (see MainContext.onSession). */
  private readonly sessionHooks: ((s: Session, info: SessionInfo) => void)[] = [];
  private readonly wiredInfo = new Map<Session, SessionInfo>();
  /** Plugin hooks run once the window is up (see MainContext.onStarted). */
  private readonly startHooks: (() => void)[] = [];
  private started = false;

  private readonly surfaces = new Map<string, Surface>();
  private mode = 'browse';

  readonly tabs: TabManager;
  readonly extensions: Extensions;
  readonly sessions: Sessions;
  readonly search: SearchSettings;
  readonly shortcuts: ShortcutManager;
  readonly profiles: Profiles;
  readonly downloads: DownloadManager;
  readonly videoTools: VideoTools;
  readonly offline: OfflineManager;

  private open: WebContentsView | null = null;
  private lastFind = '';
  /** Set once the window starts closing, so teardown can't overwrite the autosaved session. */
  private closing = false;
  /** Profile last announced to the UI (Library shows its bookmarks/history). */
  private shownProfile: string;

  constructor(
    private mw: MainWindow,
    /** Ids of the plugins in this build (plugin-owned shortcuts exist only with their plugin). */
    pluginIds: ReadonlySet<string> = new Set(),
  ) {
    const win = mw.win;
    // Overlay views are trusted but sandboxed (they only load our local pages).
    const mkOverlay = () =>
      new WebContentsView({
        webPreferences: { preload: BRIDGE_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });

    // The chrome view hosts the extension toolbar, whose preload needs Node
    // require + ipcRenderer → sandbox:false (contextIsolation stays on; it only
    // ever loads our own index.html).
    this.chrome = new WebContentsView({
      webPreferences: { preload: CHROME_PRELOAD, contextIsolation: true, sandbox: false, nodeIntegration: false },
    });
    this.settings = mkOverlay();
    this.libraryView = mkOverlay();
    this.overlays = [this.settings, this.libraryView];

    win.contentView.addChildView(this.chrome);
    void this.chrome.webContents.loadFile(CHROME_HTML);
    for (const v of this.overlays) {
      win.contentView.addChildView(v);
      v.setVisible(false);
    }
    void this.settings.webContents.loadFile(SETTINGS_HTML);
    void this.libraryView.webContents.loadFile(LIBRARY_HTML);

    // Services. Route all their events to every UI view.
    const send = (ch: string, p: unknown) => this.send(ch, p);
    this.prefs = new JsonStore<Prefs>('prefs', DEFAULT_PREFS);
    this.profiles = new Profiles();
    this.shownProfile = this.profiles.current;
    this.sessions = new Sessions(send);
    this.search = new SearchSettings(send);
    this.downloads = new DownloadManager(
      send,
      () => this.getPrefs(),
      () => (win.isDestroyed() ? null : win),
      (partition) => (partition ? session.fromPartition(partition) : session.defaultSession),
    );
    this.videoTools = new VideoTools(send);
    this.offline = new OfflineManager(
      send,
      () => this.getPrefs(),
      this.videoTools,
      (partition) => (partition ? session.fromPartition(partition) : session.defaultSession),
      (url) => {
        this.closeOverlay();
        this.tabs.newTab(url);
      },
    );

    // Private tabs: one shared in-memory session. Ads are blocked and downloads
    // tracked there too; extensions are never attached to it.
    this.privateSession = session.fromPartition(PRIVATE_PARTITION);
    this.wire(this.privateSession, { private: true, profileId: DEFAULT_PROFILE, partition: PRIVATE_PARTITION });
    this.wire(session.defaultSession, { private: false, profileId: DEFAULT_PROFILE, partition: '' });

    const tabSessions: TabSessions = {
      forProfile: (id) => this.profileSession(id),
      partition: (id) => this.profiles.partition(id),
      validProfile: (id) => this.profiles.valid(id),
      privateSession: this.privateSession,
      privatePartition: PRIVATE_PARTITION,
    };
    this.tabs = new TabManager(
      win,
      () => this.tabRegion(),
      send,
      (profileId, url, title) => this.libraryFor(profileId).addVisit(url, title),
      (profileId, url) => this.libraryFor(profileId).isBookmarked(url),
      tabSessions,
      this.profiles.current,
    );
    this.tabs.search = () => this.search.get();
    this.tabs.bridgePreload = BRIDGE_PRELOAD; // Library tabs (bro://downloads, bro://offline)
    this.tabs.onMagnet = (url, wc) => void this.openMagnet(url, wc);
    this.tabs.onChanged = () => {
      this.autosave();
      this.syncProfile();
    };
    // Pages playing a video light up the "Save for offline" button.
    this.tabs.hasVideo = (wc) => this.offline.hasVideo(wc);
    this.offline.onMediaChanged = (wcId) => this.tabs.refresh(wcId);
    // Bringing a tab forward shows the tabs (leaves API/Proxy, closes an overlay);
    // a tab opened in the background must not cover a panel/overlay on screen.
    this.tabs.onActivate = () => {
      this.closeOverlay();
      this.showBrowse();
    };
    this.tabs.afterLayout = () => this.raiseOnTop();

    // Chrome-extension runtime, one per profile (also sets tabs.hooks).
    this.extensions = new Extensions(win, this.tabs, (id) => this.profileSession(id));
    this.extensions.ensure(DEFAULT_PROFILE);

    // Right-click menus.
    this.tabs.onContextMenu = (wc, params, ctx) =>
      showTabContextMenu(wc, params, ctx, {
        window: win,
        openTab: (url, o) => this.tabs.newTab(url, o),
        saveAs: (url, w) => this.downloads.saveAs(url, w),
        saveOffline: (w, what, mediaUrl) => this.saveOffline(what, w, mediaUrl),
        resolve: (text) => this.tabs.resolve(text),
        searchEngineName: () => {
          const cfg = this.search.get();
          return cfg.engines.find((e) => e.keyword === cfg.defaultKeyword)?.name ?? 'the web';
        },
        profiles: () => this.profiles.list(),
        extensionItems: (profileId, w, p) => this.extensions.getContextMenuItems(profileId, w, p),
      });
    for (const v of [this.chrome, ...this.overlays]) {
      v.webContents.on('context-menu', (_e, params) => showUiContextMenu(v.webContents, params, win));
    }

    // Keyboard shortcuts: in-app ones are matched on every view we own.
    this.shortcuts = new ShortcutManager(
      send,
      commandHandlers(mw, this),
      (s) => this.runCustom(s),
      (id) => commandAvailable(id, pluginIds),
    );
    for (const v of [this.chrome, ...this.overlays]) this.shortcuts.attach(v.webContents);
    this.tabs.onWebContents = (wc) => {
      this.shortcuts.attach(wc);
      this.offline.track(wc);
    };

    mw.emit = send;
    win.on('resize', () => this.layout());
    // Last chance to snapshot the tabs while their webContents still exist.
    win.on('close', () => {
      this.autosave();
      this.closing = true;
    });

    this.chrome.webContents.once('did-finish-load', () => {
      const last = this.sessions.getLast();
      if (this.getPrefs().startup === 'restore' && last.tabs.length) {
        this.tabs.restore(last.tabs, last.active);
      } else {
        this.tabs.newTab();
      }
      this.layout();
      win.show();
      void this.extensions.init();   // async: Web Store + restore installed extensions
      this.downloads.init();         // continue downloads interrupted by the last exit
      this.offline.init();           // …and offline saves
      this.started = true;
      for (const hook of this.startHooks) this.runHook(() => hook());
    });
  }

  // --- Sessions: every one tabs use gets downloads + offline + plugin hooks -----

  private wire(s: Session, ctx: SessionInfo): void {
    if (this.wired.has(s)) return;
    this.wired.add(s);
    this.wiredInfo.set(s, ctx);
    this.downloads.attach(s, ctx);
    this.offline.attach(s, ctx.partition);
    for (const hook of this.sessionHooks) this.runHook(() => hook(s, ctx));
  }

  // --- Plugin host hooks ---------------------------------------------------------

  /** MainContext.onSession: run now for every wired session, and for each one wired later. */
  onSession(hook: (s: Session, info: SessionInfo) => void): void {
    this.sessionHooks.push(hook);
    for (const [s, info] of this.wiredInfo) this.runHook(() => hook(s, info));
  }

  /** MainContext.onStarted: run once the window is shown (now, if it already is). */
  onStarted(hook: () => void): void {
    if (this.started) this.runHook(hook);
    else this.startHooks.push(hook);
  }

  /** A plugin hook that throws must never take the browser down with it. */
  private runHook(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error('[plugins] hook failed', e);
    }
  }

  // --- Plugin surfaces -----------------------------------------------------------

  /** Called by the plugin host for every plugin whose manifest has a surface. */
  addSurface(spec: SurfaceSpec): void {
    this.surfaces.set(spec.mode, { spec });
  }

  getMode(): string {
    return this.mode;
  }

  /** Show one surface: 'browse' = the tabs, anything else = that plugin's panel. */
  setMode(mode: string): void {
    if (mode !== 'browse' && !this.surfaces.has(mode)) return;
    this.mode = mode;
    this.closeOverlay();

    for (const [id, s] of this.surfaces) {
      const on = id === mode;
      if (on && !s.view) s.view = this.makePanel(join(UI_DIR, s.spec.html));
      if (!s.view) continue;
      if (on) {
        this.mw.win.contentView.addChildView(s.view); // raise above the tabs
        s.view.setBounds(this.tabRegion());
        s.view.webContents.focus();
      }
      s.view.setVisible(on);
    }

    if (mode === 'browse') this.tabs.layout();
    this.send(Event.ModeChanged, mode);
  }

  /** Browsing actions (new tab, open a link…) bring the tabs back into view. */
  showBrowse(): void {
    if (this.mode !== 'browse') this.setMode('browse');
  }

  private makePanel(htmlPath: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { preload: BRIDGE_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.mw.win.contentView.addChildView(view);
    view.webContents.on('context-menu', (_e, params) => showUiContextMenu(view.webContents, params, this.mw.win));
    // Page commands act on the tab behind the panel; the panel keeps those keys
    // (Ctrl+S save, Ctrl+F, Ctrl+P…) for its own use.
    this.shortcuts.attach(view.webContents, PANEL_KEEPS);
    void view.webContents.loadFile(htmlPath);
    return view;
  }

  /** A profile's session, wired on first use (extensions too). */
  private profileSession(id: string): Session {
    const profileId = this.profiles.valid(id);
    const s = this.profiles.session(profileId);
    if (!this.wired.has(s)) {
      this.wire(s, { private: false, profileId, partition: this.profiles.partition(profileId) });
      this.extensions?.ensure(profileId);
    }
    return s;
  }

  // --- Profiles ------------------------------------------------------------------

  /** Bookmarks + history of the current profile. */
  get library(): Library {
    return this.libraryFor(this.currentProfile());
  }

  private currentProfile(): string {
    return this.tabs ? this.tabs.currentProfile : this.profiles.current;
  }

  private libraryFor(id: string): Library {
    const profileId = this.profiles.valid(id);
    let lib = this.libraries.get(profileId);
    if (!lib) {
      // Only the profile on screen talks to the Library page.
      lib = new Library((ch, p) => {
        if (profileId === this.currentProfile()) this.send(ch, p);
      }, profileId);
      this.libraries.set(profileId, lib);
    }
    return lib;
  }

  profilesState(): ProfilesState {
    return { profiles: this.profiles.list(), current: this.currentProfile() };
  }

  /** The active tab moved to another profile → Library + switcher follow it. */
  private syncProfile(): void {
    const current = this.currentProfile();
    if (current === this.shownProfile) return;
    this.shownProfile = current;
    this.profiles.setCurrent(current);
    this.send(Event.ProfilesChanged, this.profilesState());
    this.send(Event.BookmarksChanged, this.library.getBookmarks());
    this.send(Event.HistoryChanged, this.library.getHistory());
  }

  createProfile(name: string, color: string): string {
    const p = this.profiles.create(name, color);
    this.send(Event.ProfilesChanged, this.profilesState());
    this.newTabInProfile(p.id);
    return p.id;
  }

  updateProfile(id: string, patch: { name?: string; color?: string }): void {
    this.profiles.update(id, patch);
    this.send(Event.ProfilesChanged, this.profilesState());
    this.send(Event.TabsChanged, this.tabs.list());
  }

  removeProfile(id: string): boolean {
    if (id === DEFAULT_PROFILE || !this.profiles.get(id)) return false;
    this.tabs.closeProfileTabs(id);
    this.downloads.dropProfile(id);
    this.libraries.get(id)?.flush();
    this.libraries.delete(id);
    const ok = this.profiles.remove(id);
    this.shownProfile = '';
    this.syncProfile();
    this.send(Event.ProfilesChanged, this.profilesState());
    return ok;
  }

  newTabInProfile(id: string): void {
    this.closeOverlay();
    this.tabs.newTab(undefined, { profileId: this.profiles.valid(id) });
    this.focusOmnibox();
  }

  /** Native menu under the profile button: switch (= new tab in that profile), private tab, manage. */
  showProfileMenu(): void {
    const current = this.currentProfile();
    const menu = Menu.buildFromTemplate([
      ...this.profiles.list().map((p) => ({
        label: p.name,
        type: 'radio' as const,
        checked: p.id === current,
        click: () => this.newTabInProfile(p.id),
      })),
      { type: 'separator' },
      { label: 'New private tab', click: () => this.shortcuts.run('tab.newPrivate') },
      { label: 'Manage profiles…', click: () => this.openSettingsAt('profiles') },
    ]);
    menu.popup({ window: this.mw.win });
  }

  /** Cookies/cache actions in Settings apply to the profile on screen. */
  currentSession(): Session {
    return this.profileSession(this.currentProfile());
  }

  // --- Overlays ------------------------------------------------------------

  toggleSettings(): void {
    this.toggleOverlay(this.settings);
  }
  closeSettings(): void {
    this.closeOverlay();
  }
  toggleLibrary(): void {
    this.toggleOverlay(this.libraryView);
  }
  closeLibrary(): void {
    this.closeOverlay();
  }

  /** Open Settings scrolled to a section. */
  openSettingsAt(section: string): void {
    if (this.open !== this.settings) this.toggleOverlay(this.settings);
    void this.settings.webContents
      .executeJavaScript(`document.getElementById(${JSON.stringify(section)})?.scrollIntoView()`)
      .catch(() => {});
  }

  /** Open the Library on a given view (unlike toggle, never closes it). */
  /** Open a Library view as a page in a tab (Ctrl/Cmd+J → bro://downloads), like Chrome. */
  openLibraryTab(view: LibraryView): void {
    this.closeOverlay();
    this.tabs.openLibrary(view);
  }

  openLibrary(view: LibraryView): void {
    this.libraryView.webContents.send(Event.LibraryView, view);
    if (this.open !== this.libraryView) this.toggleOverlay(this.libraryView);
  }

  private toggleOverlay(view: WebContentsView): void {
    if (this.open === view) {
      this.closeOverlay();
    } else {
      if (this.open) this.open.setVisible(false);
      this.open = view;
      this.mw.win.contentView.addChildView(view); // raise to top
      view.setBounds(this.tabRegion());
      view.setVisible(true);
      view.webContents.focus();
    }
  }

  private closeOverlay(): void {
    if (!this.open) return;
    this.open.setVisible(false);
    this.open = null;
    this.chrome.webContents.focus();
  }

  /** Re-raise whatever must sit above the tab views: the visible plugin panel, then an open overlay. */
  private raiseOnTop(): void {
    const panel = this.mode === 'browse' ? undefined : this.surfaces.get(this.mode)?.view;
    for (const v of [panel, this.open]) if (v) this.mw.win.contentView.addChildView(v);
  }

  focusOmnibox(): void {
    this.closeOverlay();
    this.chrome.webContents.send(Event.FocusOmnibox);
    this.chrome.webContents.focus();
  }

  /** Bookmark (or un-bookmark) the active tab — used by Ctrl/Cmd+D. */
  bookmarkActiveTab(): void {
    const info = this.tabs.activeInfo();
    if (info) this.library.toggleBookmark(info.url, info.title);
  }

  // --- Save for offline --------------------------------------------------------

  /** Save a tab (default: the active one) for offline: page snapshot and/or its videos. */
  saveOffline(what: OfflineWhat, wc = this.tabs.activeWebContents, mediaUrl?: string): void {
    const ctx = wc && this.tabs.contextOf(wc);
    if (!wc || !ctx || !/^https?:/i.test(wc.getURL())) return;
    const partition = ctx.private ? PRIVATE_PARTITION : this.profiles.partition(ctx.profileId);
    this.offline.save(wc, { private: ctx.private, profileId: ctx.profileId, partition }, what, mediaUrl);
  }

  /** Native menu under the toolbar's "Save for offline" button. */
  showOfflineMenu(): void {
    const wc = this.tabs.activeWebContents;
    const url = wc?.getURL() ?? '';
    const web = /^https?:/i.test(url);
    const prefs = this.getPrefs();
    const tools = this.videoTools.getState();
    const playlist = web && /[?&]list=|\/playlist|\/course/i.test(url);
    const quality = VIDEO_QUALITIES.find(([q]) => q === prefs.videoQuality)?.[1].split(' — ')[0] ?? '720p HD';
    const menu = Menu.buildFromTemplate([
      { label: `Save page + video (${quality})`, enabled: web, click: () => this.saveOffline('page+video') },
      { label: 'Save video only', enabled: web, click: () => this.saveOffline('video') },
      { label: 'Save page only', enabled: web, click: () => this.saveOffline('page') },
      ...(playlist ? [{ label: 'Save the whole playlist / course', click: () => this.saveOffline('playlist') }] : []),
      { type: 'separator' },
      {
        label: 'Video quality',
        submenu: VIDEO_QUALITIES.map(([q, label]) => ({
          label,
          type: 'radio' as const,
          checked: prefs.videoQuality === q,
          click: () => this.setPrefs({ videoQuality: q }),
        })),
      },
      { label: 'Save English subtitles', type: 'checkbox', checked: prefs.videoSubtitles, click: () => this.setPrefs({ videoSubtitles: !prefs.videoSubtitles }) },
      { type: 'separator' },
      { label: 'Offline library (Ctrl+Shift+J)', click: () => this.openLibraryTab('offline') },
      ...(!tools.ready && !tools.installing
        ? [{ label: 'The first video save fetches the video tools (~50 MB, once)', enabled: false }]
        : []),
    ]);
    menu.popup({ window: this.mw.win });
  }

  // --- Find in page ----------------------------------------------------------

  showFind(): void {
    this.closeOverlay();
    this.chrome.webContents.send(Event.FindShow);
    this.chrome.webContents.focus();
  }

  find(p: FindPayload): void {
    this.lastFind = p.text;
    this.tabs.find(p);
  }

  /** F3 / Shift+F3: repeat the last search, or open the find bar if there is none. */
  findAgain(forward: boolean): void {
    if (!this.lastFind) return this.showFind();
    this.tabs.find({ text: this.lastFind, forward, newSession: false });
  }

  stopFind(): void {
    this.tabs.stopFind();
  }

  // --- Sessions --------------------------------------------------------------

  saveSession(name: string): void {
    this.sessions.save(name, this.tabs.snapshot().tabs);
  }

  /** Ctrl/Cmd+Shift+D: snapshot all tabs under a dated name, then show the list. */
  saveSessionNow(): void {
    const stamp = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    this.saveSession(`Session ${stamp}`);
    this.openLibrary('sessions');
  }

  openSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.closeOverlay();
    this.tabs.restore(s.tabs, 0);
  }

  private autosave(): void {
    if (this.closing) return;
    this.sessions.setLast(this.tabs.snapshot());
  }

  // --- Custom shortcuts ------------------------------------------------------

  private runCustom(s: CustomShortcut): void {
    if (s.global) {
      // Fired from another app: bring Bro forward to show the result.
      if (!this.mw.win.isVisible()) this.mw.win.show();
      this.mw.win.focus();
    }
    this.closeOverlay();
    if (s.newTab) this.tabs.newTab(s.target);
    else this.tabs.navigate(s.target);
  }

  // --- Persisted settings ----------------------------------------------------

  getPrefs(): Prefs {
    return { ...DEFAULT_PREFS, ...this.prefs.get() };
  }

  setPrefs(p: Partial<Prefs>): void {
    const next = this.getPrefs();
    if (p.startup === 'restore' || p.startup === 'newtab') next.startup = p.startup;
    if (typeof p.downloadDir === 'string') next.downloadDir = p.downloadDir;
    if (typeof p.askWhereToSave === 'boolean') next.askWhereToSave = p.askWhereToSave;
    if (typeof p.downloadConnections === 'number' && Number.isFinite(p.downloadConnections)) {
      next.downloadConnections = Math.min(16, Math.max(1, Math.round(p.downloadConnections)));
    }
    if (typeof p.maxDownloads === 'number' && Number.isFinite(p.maxDownloads)) {
      next.maxDownloads = Math.min(10, Math.max(1, Math.round(p.maxDownloads)));
    }
    if (typeof p.torrents === 'boolean') next.torrents = p.torrents;
    if (typeof p.videoQuality === 'number' && VIDEO_QUALITIES.some(([q]) => q === p.videoQuality)) next.videoQuality = p.videoQuality;
    if (typeof p.videoSubtitles === 'boolean') next.videoSubtitles = p.videoSubtitles;
    this.prefs.set(next);
    this.send(Event.PrefsChanged, next);
    this.downloads.schedule(); // a higher limit starts queued downloads right away
  }

  // --- Downloads ---------------------------------------------------------------

  /** Downloads page → "New download": a web address or a magnet link, in the profile on screen. */
  addDownload(raw: string): string | null {
    const url = raw.trim();
    if (/^magnet:/i.test(url)) return this.openMagnet(url);
    if (!/^https?:\/\/\S+$/i.test(url)) return 'Paste a web address (https://…) or a magnet link.';
    this.currentSession().downloadURL(url);
    return null;
  }

  /** A magnet link was clicked or typed. `wc` = the tab it came from (private tabs stay private). */
  openMagnet(url: string, wc?: WebContents): string | null {
    if (!this.getPrefs().torrents) {
      void shell.openExternal(url).catch(() => {}); // the system's torrent app
      return null;
    }
    const ctx = wc && this.tabs.contextOf(wc);
    const isPrivate = !!ctx?.private;
    const profileId = ctx?.profileId ?? this.currentProfile();
    const err = this.downloads.addTorrent(url, {
      private: isPrivate,
      profileId,
      partition: isPrivate ? PRIVATE_PARTITION : this.profiles.partition(profileId),
    });
    if (!err && wc) this.openLibraryTab('downloads'); // show it, like a download starting
    return err;
  }

  // --- Layout --------------------------------------------------------------

  private tabRegion() {
    const [w, h] = this.mw.win.getContentSize();
    return { x: 0, y: CHROME_H, width: w, height: Math.max(0, h - CHROME_H) };
  }

  private layout(): void {
    const [w] = this.mw.win.getContentSize();
    this.chrome.setBounds({ x: 0, y: 0, width: w, height: CHROME_H });
    this.tabs.layout();
    if (this.open) this.open.setBounds(this.tabRegion());
    const panel = this.surfaces.get(this.mode)?.view;
    if (panel) panel.setBounds(this.tabRegion());
  }

  /** Broadcast to every trusted UI view — used by core AND by plugins (sendToUi). */
  send(channel: string, payload?: unknown): void {
    const panels = [...this.surfaces.values()].flatMap((s) => (s.view ? [s.view] : []));
    for (const v of [this.chrome, ...this.overlays, ...panels]) {
      if (!v.webContents.isDestroyed()) v.webContents.send(channel, payload);
    }
    // Library tabs (bro://downloads, bro://offline…) get the same live updates.
    for (const wc of this.tabs?.internalWebContents() ?? []) wc.send(channel, payload);
  }

  /** Persist pending writes and release global hotkeys (window closed / app quitting). */
  flush(): void {
    this.prefs.flush();
    for (const lib of this.libraries.values()) lib.flush();
    this.sessions.flush();
    this.search.flush();
    this.profiles.flush();
    this.downloads.flush();
    this.offline.flush();
    this.shortcuts.dispose();
  }
}
