import { ipcMain } from 'electron';
import type { MainWindow } from './window';
import type { Browser } from './browser';
import type { PluginInfo } from '../core/plugin';
import { Channel, type NavigatePayload } from '../shared/ipc-contract';

/**
 * Wire the CORE renderer→main channels (window controls, tabs, settings, mode
 * switch, plugin list). Feature channels (overlay:*, opacity:*, api:*, proxy:*)
 * are registered by their own plugins' registerMain via ctx.ipc.
 */
export function registerIpc(mw: MainWindow, browser: Browser, pluginInfos: PluginInfo[]): void {
  const { tabs } = browser;

  // Frameless window controls.
  ipcMain.on(Channel.WindowMinimize, () => mw.win.minimize());
  ipcMain.on(Channel.WindowMaximizeToggle, () =>
    mw.win.isMaximized() ? mw.win.unmaximize() : mw.win.maximize(),
  );
  ipcMain.on(Channel.WindowClose, () => mw.win.close());

  // Tabs / navigation.
  ipcMain.on(Channel.TabNew, (_e, url?: string) => tabs.newTab(url));
  ipcMain.on(Channel.TabClose, (_e, id: number) => tabs.closeTab(id));
  ipcMain.on(Channel.TabActivate, (_e, id: number) => tabs.activate(id));
  ipcMain.on(Channel.TabNavigate, (_e, p: NavigatePayload) => tabs.navigate(p.input, p.id));
  ipcMain.on(Channel.TabBack, (_e, id?: number) => tabs.back(id));
  ipcMain.on(Channel.TabForward, (_e, id?: number) => tabs.forward(id));
  ipcMain.on(Channel.TabReload, (_e, id?: number) => tabs.reload(id));
  ipcMain.on(Channel.TabStop, (_e, id?: number) => tabs.stop(id));
  ipcMain.handle(Channel.TabList, () => tabs.list());

  // Settings overlay + mode switch.
  ipcMain.on(Channel.SettingsToggle, () => browser.toggleSettings());
  ipcMain.on(Channel.SettingsClose, () => browser.closeSettings());
  ipcMain.on(Channel.ModeSet, (_e, mode: string) => browser.setMode(mode));

  // Plugin host — what the chrome/settings UIs render from.
  ipcMain.handle(Channel.PluginsList, () => pluginInfos);
}
