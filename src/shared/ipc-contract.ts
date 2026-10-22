// The single source of truth for every CORE IPC channel name and payload shape
// (the browser shell: window, tabs, library, downloads, profiles, …, the mode
// switch and the plugin list). Both the main process and the preload bridge
// import from here so the two sides can never drift apart.
//
// Feature PLUGINS (overlay-hiding, opacity, adblock, api-client, proxy) define
// their own channel strings and are reached through the GENERIC plugin bus
// (`window.bro.plugin.*`), so the preload stays static as the build varies.
import type { CommandId, CustomShortcut, ShortcutGroupId, ShortcutsState } from './shortcuts';
import type { PluginInfo } from '../core/plugin';

export type { PluginInfo, SurfaceSpec } from '../core/plugin';
export type { HttpExchange, HttpRequest, HttpResponse, Header, HttpBody, Mode } from './http-model';

/** Renderer → main. */
export const Channel = {
  // Frameless window controls.
  WindowMinimize: 'window:minimize',
  WindowMaximizeToggle: 'window:maximize-toggle',
  WindowClose: 'window:close',

  // Overlay mode (click-through + float on top). Screen-share hiding and opacity
  // are plugins: 'overlay:*' / 'opacity:*' on the plugin bus.
  SetOverlayMode: 'win:set-overlay-mode',
  GetOverlayMode: 'win:get-overlay-mode',

  // Tabs / navigation.
  TabNew: 'tab:new',           // payload: string | undefined (url)
  TabClose: 'tab:close',       // payload: number (id)
  TabActivate: 'tab:activate', // payload: number (id)
  TabNavigate: 'tab:navigate', // payload: { id?: number; input: string }
  TabBack: 'tab:back',         // payload: number | undefined (id, default active)
  TabForward: 'tab:forward',
  TabReload: 'tab:reload',
  TabStop: 'tab:stop',
  TabList: 'tab:list',         // invoke → TabState[]

  // Settings page overlay.
  SettingsToggle: 'settings:toggle',
  SettingsClose: 'settings:close',

  // Library (bookmarks + history) overlay.
  LibraryToggle: 'library:toggle',
  LibraryClose: 'library:close',

  // Surface mode switch (Browse + plugin surfaces).
  ModeSet: 'mode:set',                  // payload: string (surface mode, or 'browse')

  // Plugin host.
  PluginsList: 'plugins:list',          // invoke → PluginInfo[]

  // Bookmarks.
  GetBookmarks: 'bm:list',              // invoke → Bookmark[]
  ToggleBookmark: 'bm:toggle',          // payload: { url: string; title: string }
  RemoveBookmark: 'bm:remove',          // payload: string (url)

  // History.
  GetHistory: 'hist:list',              // invoke → HistoryEntry[]
  ClearHistory: 'hist:clear',

  // Shortcuts (registry lives in shared/shortcuts.ts).
  GetShortcuts: 'sc:get',               // invoke → ShortcutsState
  SetShortcutKeys: 'sc:set-keys',       // payload: { id: string; keys: string[] }
  ResetShortcuts: 'sc:reset',           // payload: string | undefined (id; undefined = everything)
  SetGroupEnabled: 'sc:group',          // payload: { group: ShortcutGroupId; enabled: boolean }
  SetMasterTargets: 'sc:master-targets', // payload: ShortcutGroupId[]
  ToggleMaster: 'sc:master-toggle',
  SaveCustomShortcut: 'sc:custom-save', // payload: CustomShortcut (insert or update by id)
  RemoveCustomShortcut: 'sc:custom-remove', // payload: string (id)
  SetShortcutRecording: 'sc:recording', // payload: boolean — suspend all hotkeys while capturing one
  RunCommand: 'sc:run',                 // payload: CommandId

  // Search engines + omnibox keywords.
  GetSearch: 'search:get',              // invoke → SearchConfig
  SetSearch: 'search:set',              // payload: SearchConfig

  // Find in page.
  FindInPage: 'find:go',                // payload: FindPayload
  FindStop: 'find:stop',

  // Saved sessions (named snapshots of open tabs).
  GetSessions: 'sess:list',             // invoke → SavedSession[]
  SaveSession: 'sess:save',             // payload: string (name)
  OpenSession: 'sess:open',             // payload: string (id)
  RemoveSession: 'sess:remove',         // payload: string (id)

  // Startup + stored data.
  GetPrefs: 'prefs:get',                // invoke → Prefs
  SetPrefs: 'prefs:set',                // payload: Partial<Prefs>
  ExportData: 'data:export',            // invoke → string | null (saved path)
  ImportData: 'data:import',            // invoke → string | null (summary)
  ClearCookies: 'data:clear-cookies',   // invoke → void
  ClearCache: 'data:clear-cache',       // invoke → void
  GetDataDir: 'data:dir',               // invoke → string

  // Profiles (separate browsers: own cookies, logins, history, bookmarks, extensions).
  GetProfiles: 'prof:list',             // invoke → ProfilesState
  CreateProfile: 'prof:create',         // invoke { name, color } → string (new id); opens a tab in it
  UpdateProfile: 'prof:update',         // payload: { id, name?, color? }
  RemoveProfile: 'prof:remove',         // invoke id → boolean
  NewTabInProfile: 'prof:new-tab',      // payload: string (profile id)
  ShowProfileMenu: 'prof:menu',         // pop up the profile switcher menu

  // Downloads.
  GetDownloads: 'dl:list',              // invoke → DownloadInfo[]
  DownloadCommand: 'dl:action',         // payload: { id, action: DownloadAction }
  ClearDownloads: 'dl:clear',           // remove finished/failed entries from the list
  ChooseDownloadDir: 'dl:choose-dir',   // invoke → string | null (picked folder)
  SetDownloadPriority: 'dl:priority',   // payload: { id, priority: DownloadPriority }
  AddDownload: 'dl:add',                // invoke url | magnet → string | null (error)
  OpenDownloadsFolder: 'dl:open-folder',
  PauseAllDownloads: 'dl:pause-all',
  ResumeAllDownloads: 'dl:resume-all',

  // Save for offline (page snapshot + its videos) and the video tools behind it.
  ShowOfflineMenu: 'off:menu',          // pop up the "Save for offline" menu for the active tab
  SaveOffline: 'off:save',              // payload: OfflineWhat — save the active tab
  GetOffline: 'off:list',               // invoke → OfflineItem[]
  OfflineCommand: 'off:action',         // payload: { id, action: OfflineAction }
  ClearOffline: 'off:clear',            // remove finished/failed entries from the list (files stay)
  GetVideoTools: 'vt:get',              // invoke → VideoToolsState
  InstallVideoTools: 'vt:install',      // download (or update) ffmpeg + yt-dlp
} as const;

/** Main → renderer. */
export const Event = {
  // The window emits these whenever the value changes (hotkey, IPC or plugin);
  // they share the opacity / overlay-hiding plugins' channel names.
  OpacityChanged: 'opacity:changed',     // payload: number
  CaptureHiddenChanged: 'overlay:changed', // payload: boolean
  OverlayModeChanged: 'evt:overlay-mode-changed',
  MaximizedChanged: 'evt:maximized-changed',
  TabsChanged: 'evt:tabs-changed',       // payload: TabState[]
  FocusOmnibox: 'evt:focus-omnibox',     // tell the chrome UI to focus the address bar
  ModeChanged: 'evt:mode-changed',       // payload: string (surface mode)
  BookmarksChanged: 'evt:bookmarks',     // payload: Bookmark[]
  HistoryChanged: 'evt:history',         // payload: HistoryEntry[]
  ShortcutsChanged: 'evt:shortcuts',     // payload: ShortcutsState
  SearchChanged: 'evt:search',           // payload: SearchConfig
  FindShow: 'evt:find-show',             // tell the chrome UI to open + focus the find bar
  FindResult: 'evt:find-result',         // payload: FindResult
  SessionsChanged: 'evt:sessions',       // payload: SavedSession[]
  LibraryView: 'evt:library-view',       // payload: LibraryView
  PrefsChanged: 'evt:prefs',             // payload: Prefs
  ProfilesChanged: 'evt:profiles',       // payload: ProfilesState
  DownloadsChanged: 'evt:downloads',     // payload: DownloadInfo[]
  OfflineChanged: 'evt:offline',         // payload: OfflineItem[]
  VideoToolsChanged: 'evt:video-tools',  // payload: VideoToolsState
} as const;

export type LibraryView = 'bookmarks' | 'history' | 'sessions' | 'downloads' | 'offline';

/** Colours a profile can take (its tabs get a stripe in it). */
export const PROFILE_COLORS = ['#4f46e5', '#16a34a', '#ea580c', '#db2777', '#0891b2', '#ca8a04', '#7c3aed', '#64748b'];

/** A profile is a separate browser: own session (cookies, storage), history, bookmarks, extensions. */
export interface Profile {
  id: string;     // 'default' for the original profile
  name: string;
  color: string;  // CSS colour, used on its tabs
}

export interface ProfilesState {
  profiles: Profile[];
  current: string; // profile of the active (non-private) tab — new tabs open in it
}

/** 'queued' = waiting for a free slot (Settings → Downloads → simultaneous downloads). */
export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'interrupted' | 'completed' | 'cancelled' | 'failed';
/** 'start-now' runs a queued download straight away, outside the simultaneous-downloads limit. */
export type DownloadAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'open' | 'show' | 'remove' | 'start-now';
/** Queue order, like Free Download Manager: high starts before normal before low. */
export type DownloadPriority = 'high' | 'normal' | 'low';
export const DOWNLOAD_PRIORITIES: DownloadPriority[] = ['high', 'normal', 'low'];

export interface DownloadInfo {
  id: string;
  url: string;
  filename: string;
  path: string;          // final location
  total: number;         // bytes, -1 if the server didn't say
  received: number;
  speed: number;         // bytes/s, 0 when idle
  status: DownloadStatus;
  error?: string;
  /** 'segmented' = Bro's multi-connection engine; 'browser' = Chromium's own downloader; 'torrent' = BitTorrent. */
  engine: 'segmented' | 'browser' | 'torrent';
  connections: number;   // live connections right now (peers, for a torrent)
  priority: DownloadPriority;
  forced: boolean;       // started with "Start now" — not counted against the limit
  resumable: boolean;    // can continue from where it stopped (incl. after a restart)
  retries: number;       // automatic retries so far
  started: number;
  finished?: number;
  private: boolean;      // from a private tab: never written to disk-backed history
  profileId: string;
}

/** What "Save for offline" keeps: page + its videos, only the videos, only the page, or a whole playlist. */
export type OfflineWhat = 'page+video' | 'video' | 'page' | 'playlist';
export type OfflineStatus = 'queued' | 'working' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export type OfflineAction = 'open' | 'show' | 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'delete';

/** One "Save for offline": a folder with page.mhtml, the videos, subtitles and an index.html player. */
export interface OfflineItem {
  id: string;
  title: string;
  pageUrl: string;
  what: OfflineWhat;
  folder: string;
  status: OfflineStatus;
  stage: string;         // what it's doing now, in words ("Video 2 of 5: …")
  received: number;      // bytes of the file being fetched now
  total: number;         // -1 if unknown
  speed: number;         // bytes/s
  eta: number;           // seconds, -1 if unknown
  videos: number;        // videos saved so far
  error?: string;
  started: number;
  finished?: number;
  private: boolean;
  profileId: string;
}

/** ffmpeg (merge/convert any format) + yt-dlp (finds the video on 1000s of sites). Fetched once, on first use. */
export interface VideoToolsState {
  ready: boolean;
  installing: boolean;
  progress: number;      // 0–1 while installing
  error?: string;
  ytdlpVersion?: string;
}

/** Omnibox site search: typing "yt lofi" runs the "yt" engine. `url` holds a %s placeholder. */
export interface SearchEngine {
  keyword: string;
  name: string;
  url: string;
}

export interface SearchConfig {
  engines: SearchEngine[];
  defaultKeyword: string; // engine used for plain searches
}

export interface FindPayload {
  text: string;
  forward: boolean;
  newSession: boolean; // true when the text changed; false for next/previous
}

export interface FindResult {
  active: number;
  total: number;
}

export interface SessionTab {
  url: string;
  title: string;
  favicon?: string;
  profileId?: string; // missing = the default profile
}

export interface SavedSession {
  id: string;
  name: string;
  ts: number;
  tabs: SessionTab[];
}

export interface Prefs {
  startup: 'restore' | 'newtab'; // reopen last session's tabs, or start with one new tab
  downloadDir: string;           // '' = the system Downloads folder
  askWhereToSave: boolean;
  downloadConnections: number;   // max parallel connections per download (1–16)
  maxDownloads: number;          // downloads running at once (1–10); the rest wait in the queue
  torrents: boolean;             // open magnet links and .torrent files in Bro (off = hand them to the system)
  videoQuality: number;          // offline videos: max height (360/480/720/1080), 0 = best, -1 = audio only
  videoSubtitles: boolean;       // offline videos: also save English subtitles
}

/** Stats the adblock plugin broadcasts on 'adblock:stats' (and returns from 'adblock:get'). */
export interface AdblockStats {
  enabled: boolean;
  blocked: number;   // count this session
  ready: boolean;    // engine loaded yet
  loading: boolean;  // download/parse in progress
  error?: string;    // last load failure, if any
}

export interface Bookmark {
  url: string;
  title: string;
  ts: number;
}

export interface HistoryEntry {
  url: string;
  title: string;
  ts: number;
}

export interface TabState {
  id: number;
  title: string;
  url: string;        // '' for the internal start page
  active: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  bookmarked: boolean;
  favicon?: string;
  zoom: number;       // zoom factor, 1 = 100%
  sleeping: boolean;  // restored but not loaded yet (loads on first activation)
  private: boolean;   // in-memory private session: no history, no extensions
  profileId: string;  // profile the tab belongs to (ignored for private tabs)
  partition: string;  // Electron partition of its session ('' = default) — for the extension toolbar
  hasVideo: boolean;  // a video or stream was seen on this page (lights up "Save for offline")
}

export interface NavigatePayload {
  id?: number;
  input: string;
}

/** Generic bus so any plugin UI can talk to its main-process half without a
 *  bespoke preload change. Only trusted views (chrome/settings/panels) get the
 *  preload, so web content can never reach this. */
export interface PluginBus {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  send(channel: string, ...args: unknown[]): void;
  on<T = unknown>(channel: string, cb: (payload: T) => void): () => void;
}

/** The API surface exposed on `window.bro` by the preload bridge. */
export interface BroApi {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;

  setOverlayMode(on: boolean): void;
  getOverlayMode(): Promise<boolean>;

  newTab(url?: string): void;
  closeTab(id: number): void;
  activateTab(id: number): void;
  navigate(input: string, id?: number): void;
  goBack(id?: number): void;
  goForward(id?: number): void;
  reload(id?: number): void;
  stop(id?: number): void;
  listTabs(): Promise<TabState[]>;

  toggleSettings(): void;
  closeSettings(): void;
  toggleLibrary(): void;
  closeLibrary(): void;

  setMode(mode: string): void;
  activePlugins(): Promise<PluginInfo[]>;

  getBookmarks(): Promise<Bookmark[]>;
  toggleBookmark(url: string, title: string): void;
  removeBookmark(url: string): void;

  getHistory(): Promise<HistoryEntry[]>;
  clearHistory(): void;

  getShortcuts(): Promise<ShortcutsState>;
  setShortcutKeys(id: string, keys: string[]): void;
  resetShortcuts(id?: string): void;
  setGroupEnabled(group: ShortcutGroupId, enabled: boolean): void;
  setMasterTargets(groups: ShortcutGroupId[]): void;
  toggleMaster(): void;
  saveCustomShortcut(s: CustomShortcut): void;
  removeCustomShortcut(id: string): void;
  setShortcutRecording(on: boolean): void;
  runCommand(id: CommandId): void;

  getSearch(): Promise<SearchConfig>;
  setSearch(cfg: SearchConfig): void;

  findInPage(p: FindPayload): void;
  stopFind(): void;

  getSessions(): Promise<SavedSession[]>;
  saveSession(name: string): void;
  openSession(id: string): void;
  removeSession(id: string): void;

  getPrefs(): Promise<Prefs>;
  setPrefs(p: Partial<Prefs>): void;
  exportData(): Promise<string | null>;
  importData(): Promise<string | null>;
  clearCookies(): Promise<void>;
  clearCache(): Promise<void>;
  getDataDir(): Promise<string>;

  getProfiles(): Promise<ProfilesState>;
  createProfile(name: string, color: string): Promise<string>;
  updateProfile(id: string, patch: { name?: string; color?: string }): void;
  removeProfile(id: string): Promise<boolean>;
  newTabInProfile(id: string): void;
  showProfileMenu(): void;

  getDownloads(): Promise<DownloadInfo[]>;
  downloadAction(id: string, action: DownloadAction): void;
  clearDownloads(): void;
  chooseDownloadDir(): Promise<string | null>;
  setDownloadPriority(id: string, priority: DownloadPriority): void;
  addDownload(url: string): Promise<string | null>;
  openDownloadsFolder(): void;
  pauseAllDownloads(): void;
  resumeAllDownloads(): void;

  showOfflineMenu(): void;
  saveOffline(what: OfflineWhat): void;
  getOffline(): Promise<OfflineItem[]>;
  offlineAction(id: string, action: OfflineAction): void;
  clearOffline(): void;
  getVideoTools(): Promise<VideoToolsState>;
  installVideoTools(): void;

  onOverlayModeChanged(cb: (on: boolean) => void): () => void;
  onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
  onTabsChanged(cb: (tabs: TabState[]) => void): () => void;
  onFocusOmnibox(cb: () => void): () => void;
  onModeChanged(cb: (mode: string) => void): () => void;
  onBookmarksChanged(cb: (bookmarks: Bookmark[]) => void): () => void;
  onHistoryChanged(cb: (history: HistoryEntry[]) => void): () => void;
  onShortcutsChanged(cb: (state: ShortcutsState) => void): () => void;
  onSearchChanged(cb: (cfg: SearchConfig) => void): () => void;
  onFindShow(cb: () => void): () => void;
  onFindResult(cb: (r: FindResult) => void): () => void;
  onSessionsChanged(cb: (sessions: SavedSession[]) => void): () => void;
  onLibraryView(cb: (view: LibraryView) => void): () => void;
  onPrefsChanged(cb: (p: Prefs) => void): () => void;
  onProfilesChanged(cb: (s: ProfilesState) => void): () => void;
  onDownloadsChanged(cb: (list: DownloadInfo[]) => void): () => void;
  onOfflineChanged(cb: (list: OfflineItem[]) => void): () => void;
  onVideoToolsChanged(cb: (s: VideoToolsState) => void): () => void;

  /** Generic bus for plugin UIs (and plugin-owned settings sections). */
  readonly plugin: PluginBus;

  readonly platform: NodeJS.Platform;
}

declare global {
  interface Window {
    bro: BroApi;
  }
}
