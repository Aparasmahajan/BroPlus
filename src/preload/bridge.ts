import { contextBridge, ipcRenderer } from 'electron';
import {
  Channel,
  Event,
  type BroApi,
  type NavigatePayload,
  type TabState,
  type PluginInfo,
  type Bookmark,
  type HistoryEntry,
  type SearchConfig,
  type FindResult,
  type SavedSession,
  type LibraryView,
  type Prefs,
  type ProfilesState,
  type DownloadInfo,
  type OfflineItem,
  type VideoToolsState,
} from '../shared/ipc-contract';
import type { ShortcutsState } from '../shared/shortcuts';

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: BroApi = {
  minimize: () => ipcRenderer.send(Channel.WindowMinimize),
  toggleMaximize: () => ipcRenderer.send(Channel.WindowMaximizeToggle),
  close: () => ipcRenderer.send(Channel.WindowClose),

  setOverlayMode: (on) => ipcRenderer.send(Channel.SetOverlayMode, on),
  getOverlayMode: () => ipcRenderer.invoke(Channel.GetOverlayMode),

  newTab: (url) => ipcRenderer.send(Channel.TabNew, url),
  closeTab: (id) => ipcRenderer.send(Channel.TabClose, id),
  activateTab: (id) => ipcRenderer.send(Channel.TabActivate, id),
  navigate: (input, id) => ipcRenderer.send(Channel.TabNavigate, { input, id } as NavigatePayload),
  goBack: (id) => ipcRenderer.send(Channel.TabBack, id),
  goForward: (id) => ipcRenderer.send(Channel.TabForward, id),
  reload: (id) => ipcRenderer.send(Channel.TabReload, id),
  stop: (id) => ipcRenderer.send(Channel.TabStop, id),
  listTabs: () => ipcRenderer.invoke(Channel.TabList) as Promise<TabState[]>,

  toggleSettings: () => ipcRenderer.send(Channel.SettingsToggle),
  closeSettings: () => ipcRenderer.send(Channel.SettingsClose),
  toggleLibrary: () => ipcRenderer.send(Channel.LibraryToggle),
  closeLibrary: () => ipcRenderer.send(Channel.LibraryClose),

  setMode: (mode) => ipcRenderer.send(Channel.ModeSet, mode),
  activePlugins: () => ipcRenderer.invoke(Channel.PluginsList) as Promise<PluginInfo[]>,

  getBookmarks: () => ipcRenderer.invoke(Channel.GetBookmarks) as Promise<Bookmark[]>,
  toggleBookmark: (url, title) => ipcRenderer.send(Channel.ToggleBookmark, { url, title }),
  removeBookmark: (url) => ipcRenderer.send(Channel.RemoveBookmark, url),

  getHistory: () => ipcRenderer.invoke(Channel.GetHistory) as Promise<HistoryEntry[]>,
  clearHistory: () => ipcRenderer.send(Channel.ClearHistory),

  getShortcuts: () => ipcRenderer.invoke(Channel.GetShortcuts) as Promise<ShortcutsState>,
  setShortcutKeys: (id, keys) => ipcRenderer.send(Channel.SetShortcutKeys, { id, keys }),
  resetShortcuts: (id) => ipcRenderer.send(Channel.ResetShortcuts, id),
  setGroupEnabled: (group, enabled) => ipcRenderer.send(Channel.SetGroupEnabled, { group, enabled }),
  setMasterTargets: (groups) => ipcRenderer.send(Channel.SetMasterTargets, groups),
  toggleMaster: () => ipcRenderer.send(Channel.ToggleMaster),
  saveCustomShortcut: (s) => ipcRenderer.send(Channel.SaveCustomShortcut, s),
  removeCustomShortcut: (id) => ipcRenderer.send(Channel.RemoveCustomShortcut, id),
  setShortcutRecording: (on) => ipcRenderer.send(Channel.SetShortcutRecording, on),
  runCommand: (id) => ipcRenderer.send(Channel.RunCommand, id),

  getSearch: () => ipcRenderer.invoke(Channel.GetSearch) as Promise<SearchConfig>,
  setSearch: (cfg) => ipcRenderer.send(Channel.SetSearch, cfg),

  findInPage: (p) => ipcRenderer.send(Channel.FindInPage, p),
  stopFind: () => ipcRenderer.send(Channel.FindStop),

  getSessions: () => ipcRenderer.invoke(Channel.GetSessions) as Promise<SavedSession[]>,
  saveSession: (name) => ipcRenderer.send(Channel.SaveSession, name),
  openSession: (id) => ipcRenderer.send(Channel.OpenSession, id),
  removeSession: (id) => ipcRenderer.send(Channel.RemoveSession, id),

  getPrefs: () => ipcRenderer.invoke(Channel.GetPrefs) as Promise<Prefs>,
  setPrefs: (p) => ipcRenderer.send(Channel.SetPrefs, p),
  exportData: () => ipcRenderer.invoke(Channel.ExportData) as Promise<string | null>,
  importData: () => ipcRenderer.invoke(Channel.ImportData) as Promise<string | null>,
  clearCookies: () => ipcRenderer.invoke(Channel.ClearCookies) as Promise<void>,
  clearCache: () => ipcRenderer.invoke(Channel.ClearCache) as Promise<void>,
  getDataDir: () => ipcRenderer.invoke(Channel.GetDataDir) as Promise<string>,

  getProfiles: () => ipcRenderer.invoke(Channel.GetProfiles) as Promise<ProfilesState>,
  createProfile: (name, color) => ipcRenderer.invoke(Channel.CreateProfile, { name, color }) as Promise<string>,
  updateProfile: (id, patch) => ipcRenderer.send(Channel.UpdateProfile, { id, ...patch }),
  removeProfile: (id) => ipcRenderer.invoke(Channel.RemoveProfile, id) as Promise<boolean>,
  newTabInProfile: (id) => ipcRenderer.send(Channel.NewTabInProfile, id),
  showProfileMenu: () => ipcRenderer.send(Channel.ShowProfileMenu),

  getDownloads: () => ipcRenderer.invoke(Channel.GetDownloads) as Promise<DownloadInfo[]>,
  downloadAction: (id, action) => ipcRenderer.send(Channel.DownloadCommand, { id, action }),
  clearDownloads: () => ipcRenderer.send(Channel.ClearDownloads),
  chooseDownloadDir: () => ipcRenderer.invoke(Channel.ChooseDownloadDir) as Promise<string | null>,
  setDownloadPriority: (id, priority) => ipcRenderer.send(Channel.SetDownloadPriority, { id, priority }),
  addDownload: (url) => ipcRenderer.invoke(Channel.AddDownload, url) as Promise<string | null>,
  openDownloadsFolder: () => ipcRenderer.send(Channel.OpenDownloadsFolder),
  pauseAllDownloads: () => ipcRenderer.send(Channel.PauseAllDownloads),
  resumeAllDownloads: () => ipcRenderer.send(Channel.ResumeAllDownloads),

  showOfflineMenu: () => ipcRenderer.send(Channel.ShowOfflineMenu),
  saveOffline: (what) => ipcRenderer.send(Channel.SaveOffline, what),
  getOffline: () => ipcRenderer.invoke(Channel.GetOffline) as Promise<OfflineItem[]>,
  offlineAction: (id, action) => ipcRenderer.send(Channel.OfflineCommand, { id, action }),
  clearOffline: () => ipcRenderer.send(Channel.ClearOffline),
  getVideoTools: () => ipcRenderer.invoke(Channel.GetVideoTools) as Promise<VideoToolsState>,
  installVideoTools: () => ipcRenderer.send(Channel.InstallVideoTools),

  onOverlayModeChanged: (cb) => on<boolean>(Event.OverlayModeChanged, cb),
  onMaximizedChanged: (cb) => on<boolean>(Event.MaximizedChanged, cb),
  onTabsChanged: (cb) => on<TabState[]>(Event.TabsChanged, cb),
  onFocusOmnibox: (cb) => on<void>(Event.FocusOmnibox, () => cb()),
  onModeChanged: (cb) => on<string>(Event.ModeChanged, cb),
  onBookmarksChanged: (cb) => on<Bookmark[]>(Event.BookmarksChanged, cb),
  onHistoryChanged: (cb) => on<HistoryEntry[]>(Event.HistoryChanged, cb),
  onShortcutsChanged: (cb) => on<ShortcutsState>(Event.ShortcutsChanged, cb),
  onSearchChanged: (cb) => on<SearchConfig>(Event.SearchChanged, cb),
  onFindShow: (cb) => on<void>(Event.FindShow, () => cb()),
  onFindResult: (cb) => on<FindResult>(Event.FindResult, cb),
  onSessionsChanged: (cb) => on<SavedSession[]>(Event.SessionsChanged, cb),
  onLibraryView: (cb) => on<LibraryView>(Event.LibraryView, cb),
  onPrefsChanged: (cb) => on<Prefs>(Event.PrefsChanged, cb),
  onProfilesChanged: (cb) => on<ProfilesState>(Event.ProfilesChanged, cb),
  onDownloadsChanged: (cb) => on<DownloadInfo[]>(Event.DownloadsChanged, cb),
  onOfflineChanged: (cb) => on<OfflineItem[]>(Event.OfflineChanged, cb),
  onVideoToolsChanged: (cb) => on<VideoToolsState>(Event.VideoToolsChanged, cb),

  // Generic bus: how every plugin UI reaches its main-process half. Only trusted
  // views (chrome/settings/panels/Library tabs) receive this preload, so web
  // content can't use it. Plugins own their channel-name discipline.
  plugin: {
    invoke: <T = unknown>(channel: string, ...args: unknown[]) =>
      ipcRenderer.invoke(channel, ...args) as Promise<T>,
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
    on: <T = unknown>(channel: string, cb: (payload: T) => void) => on<T>(channel, cb),
  },

  platform: process.platform,
};

// Only Bro's own pages (dist/ui/*.html, also inside app.asar) get the bridge — defence in
// depth for Library tabs, which live in the tab area next to web pages.
if (location.protocol === 'file:' && /\/dist\/ui\/[\w-]+\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('bro', api);
}
