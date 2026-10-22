import { app, dialog, ipcMain } from 'electron';
import type { MainWindow } from './window';
import type { Browser } from './browser';
import { exportData, importData } from './data';
import type { PluginInfo } from '../core/plugin';
import {
  Channel,
  type FindPayload,
  type NavigatePayload,
  type DownloadAction,
  type DownloadPriority,
  type OfflineAction,
  type OfflineWhat,
  type Prefs,
  type SearchConfig,
} from '../shared/ipc-contract';
import { isCommandId, type CustomShortcut, type ShortcutGroupId } from '../shared/shortcuts';

/**
 * Wire every CORE renderer→main channel to the window + browser controllers.
 * Feature channels (overlay:*, opacity:*, adblock:*, api:*, proxy:*) are
 * registered by their own plugins' registerMain via ctx.ipc.
 */
export function registerIpc(mw: MainWindow, browser: Browser, pluginInfos: PluginInfo[]): void {
  // On macOS the app outlives its window and boots a fresh one on 'activate';
  // drop the old handlers first (ipcMain.handle throws on a duplicate).
  for (const ch of Object.values(Channel)) {
    ipcMain.removeHandler(ch);
    ipcMain.removeAllListeners(ch);
  }

  const { tabs, shortcuts } = browser;

  // Frameless window controls.
  ipcMain.on(Channel.WindowMinimize, () => mw.win.minimize());
  ipcMain.on(Channel.WindowMaximizeToggle, () =>
    mw.win.isMaximized() ? mw.win.unmaximize() : mw.win.maximize(),
  );
  ipcMain.on(Channel.WindowClose, () => mw.win.close());

  // Overlay mode (click-through + on top).
  ipcMain.on(Channel.SetOverlayMode, (_e, on: boolean) => mw.setOverlayMode(on));
  ipcMain.handle(Channel.GetOverlayMode, () => mw.getOverlayMode());

  // Tabs / navigation.
  ipcMain.on(Channel.TabNew, (_e, url?: string) => tabs.newTab(url));
  ipcMain.on(Channel.TabClose, (_e, id: number) => tabs.closeTab(id));
  ipcMain.on(Channel.TabActivate, (_e, id: number) => tabs.activate(id));
  // Acting on the page from the toolbar brings the tabs back into view (leaves API/Proxy).
  const onPage = (fn: () => void) => {
    browser.showBrowse();
    fn();
  };
  ipcMain.on(Channel.TabNavigate, (_e, p: NavigatePayload) => onPage(() => tabs.navigate(p.input, p.id)));
  ipcMain.on(Channel.TabBack, (_e, id?: number) => onPage(() => tabs.back(id)));
  ipcMain.on(Channel.TabForward, (_e, id?: number) => onPage(() => tabs.forward(id)));
  ipcMain.on(Channel.TabReload, (_e, id?: number) => onPage(() => tabs.reload(id)));
  ipcMain.on(Channel.TabStop, (_e, id?: number) => tabs.stop(id));
  ipcMain.handle(Channel.TabList, () => tabs.list());

  // Overlays.
  ipcMain.on(Channel.SettingsToggle, () => browser.toggleSettings());
  ipcMain.on(Channel.SettingsClose, () => browser.closeSettings());
  ipcMain.on(Channel.LibraryToggle, () => browser.toggleLibrary());
  ipcMain.on(Channel.LibraryClose, () => browser.closeLibrary());

  // Mode switch + plugin host (what the chrome/settings UIs render from).
  ipcMain.on(Channel.ModeSet, (_e, mode: string) => browser.setMode(String(mode)));
  ipcMain.handle(Channel.PluginsList, () => pluginInfos);

  // Bookmarks.
  ipcMain.handle(Channel.GetBookmarks, () => browser.library.getBookmarks());
  ipcMain.on(Channel.ToggleBookmark, (_e, p: { url: string; title: string }) =>
    browser.library.toggleBookmark(p.url, p.title),
  );
  ipcMain.on(Channel.RemoveBookmark, (_e, url: string) => browser.library.removeBookmark(url));

  // History.
  ipcMain.handle(Channel.GetHistory, () => browser.library.getHistory());
  ipcMain.on(Channel.ClearHistory, () => browser.library.clearHistory());

  // Shortcuts.
  ipcMain.handle(Channel.GetShortcuts, () => shortcuts.state());
  ipcMain.on(Channel.SetShortcutKeys, (_e, p: { id: string; keys: string[] }) =>
    shortcuts.setKeys(String(p.id), Array.isArray(p.keys) ? p.keys.map(String) : []),
  );
  ipcMain.on(Channel.ResetShortcuts, (_e, id?: string) => shortcuts.reset(id || undefined));
  ipcMain.on(Channel.SetGroupEnabled, (_e, p: { group: ShortcutGroupId; enabled: boolean }) =>
    shortcuts.setGroupEnabled(p.group, !!p.enabled),
  );
  ipcMain.on(Channel.SetMasterTargets, (_e, groups: ShortcutGroupId[]) =>
    shortcuts.setMasterTargets(Array.isArray(groups) ? groups : []),
  );
  ipcMain.on(Channel.ToggleMaster, () => shortcuts.toggleMaster());
  ipcMain.on(Channel.SaveCustomShortcut, (_e, s: CustomShortcut) => shortcuts.saveCustom(s));
  ipcMain.on(Channel.RemoveCustomShortcut, (_e, id: string) => shortcuts.removeCustom(id));
  ipcMain.on(Channel.SetShortcutRecording, (_e, on: boolean) => shortcuts.setRecording(!!on));
  ipcMain.on(Channel.RunCommand, (_e, id: string) => {
    if (isCommandId(id)) shortcuts.run(id);
  });

  // Search engines.
  ipcMain.handle(Channel.GetSearch, () => browser.search.get());
  ipcMain.on(Channel.SetSearch, (_e, cfg: SearchConfig) => browser.search.set(cfg));

  // Find in page.
  ipcMain.on(Channel.FindInPage, (_e, p: FindPayload) => browser.find(p));
  ipcMain.on(Channel.FindStop, () => browser.stopFind());

  // Saved sessions.
  ipcMain.handle(Channel.GetSessions, () => browser.sessions.list());
  ipcMain.on(Channel.SaveSession, (_e, name: string) => browser.saveSession(String(name ?? '')));
  ipcMain.on(Channel.OpenSession, (_e, id: string) => browser.openSession(id));
  ipcMain.on(Channel.RemoveSession, (_e, id: string) => browser.sessions.remove(id));

  // Startup + stored data.
  ipcMain.handle(Channel.GetPrefs, () => browser.getPrefs());
  ipcMain.on(Channel.SetPrefs, (_e, p: Partial<Prefs>) => browser.setPrefs(p ?? {}));
  ipcMain.handle(Channel.ExportData, () => exportData(mw, browser));
  ipcMain.handle(Channel.ImportData, () => importData(mw, browser));
  // Cookies / cache belong to a profile: act on the one on screen.
  ipcMain.handle(Channel.ClearCookies, () => browser.currentSession().clearStorageData({ storages: ['cookies'] }));
  ipcMain.handle(Channel.ClearCache, () => browser.currentSession().clearCache());
  ipcMain.handle(Channel.GetDataDir, () => app.getPath('userData'));

  // Profiles.
  ipcMain.handle(Channel.GetProfiles, () => browser.profilesState());
  ipcMain.handle(Channel.CreateProfile, (_e, p: { name: string; color: string }) =>
    browser.createProfile(String(p?.name ?? ''), String(p?.color ?? '')),
  );
  ipcMain.on(Channel.UpdateProfile, (_e, p: { id: string; name?: string; color?: string }) =>
    browser.updateProfile(String(p.id), { name: p.name, color: p.color }),
  );
  ipcMain.handle(Channel.RemoveProfile, (_e, id: string) => browser.removeProfile(String(id)));
  ipcMain.on(Channel.NewTabInProfile, (_e, id: string) => browser.newTabInProfile(String(id)));
  ipcMain.on(Channel.ShowProfileMenu, () => browser.showProfileMenu());

  // Downloads.
  ipcMain.handle(Channel.GetDownloads, () => browser.downloads.list());
  ipcMain.on(Channel.DownloadCommand, (_e, p: { id: string; action: DownloadAction }) =>
    browser.downloads.command(String(p.id), p.action),
  );
  ipcMain.on(Channel.ClearDownloads, () => browser.downloads.clear());
  ipcMain.handle(Channel.ChooseDownloadDir, async () => {
    const r = await dialog.showOpenDialog(mw.win, { title: 'Download folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.on(Channel.SetDownloadPriority, (_e, p: { id: string; priority: DownloadPriority }) =>
    browser.downloads.setPriority(String(p.id), p.priority),
  );
  ipcMain.handle(Channel.AddDownload, (_e, url: string) => browser.addDownload(String(url ?? '')));
  ipcMain.on(Channel.OpenDownloadsFolder, () => browser.downloads.openFolder());
  ipcMain.on(Channel.PauseAllDownloads, () => browser.downloads.pauseAll());
  ipcMain.on(Channel.ResumeAllDownloads, () => browser.downloads.resumeAll());

  // Save for offline + video tools.
  const whats: OfflineWhat[] = ['page+video', 'video', 'page', 'playlist'];
  ipcMain.on(Channel.ShowOfflineMenu, () => browser.showOfflineMenu());
  ipcMain.on(Channel.SaveOffline, (_e, what: OfflineWhat) => {
    if (whats.includes(what)) browser.saveOffline(what);
  });
  ipcMain.handle(Channel.GetOffline, () => browser.offline.list());
  ipcMain.on(Channel.OfflineCommand, (_e, p: { id: string; action: OfflineAction }) =>
    browser.offline.command(String(p.id), p.action),
  );
  ipcMain.on(Channel.ClearOffline, () => browser.offline.clear());
  ipcMain.handle(Channel.GetVideoTools, () => browser.videoTools.getState());
  ipcMain.on(Channel.InstallVideoTools, () => void browser.videoTools.install().catch(() => {})); // errors land in the state
}
