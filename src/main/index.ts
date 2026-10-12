import { app, BrowserWindow, globalShortcut, ipcMain, session } from 'electron';
import { MainWindow } from './window';
import { Browser } from './browser';
import { registerIpc } from './ipc';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { buildMenu } from './menu';
import type { MainContext, PluginInfo } from '../core/plugin';
import { activePlugins } from '../generated/active-plugins';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mw: MainWindow | null = null;

  const configDir = process.env.BRO_PLUS_CONFIG_DIR?.trim() || app.getPath('userData');

  const boot = () => {
    mw = new MainWindow();
    const browser = new Browser(mw);

    // --- Plugin host (ARCHITECTURE.md §A) --------------------------------
    // Register every build-selected plugin. Surfaces are added to the browser;
    // each plugin wires its own IPC/engines/hotkeys through the MainContext.
    const ctx: MainContext = {
      app,
      win: mw.win,
      ipc: ipcMain,
      session: session.defaultSession,
      configDir,
      sendToUi: (channel, payload) => browser.send(channel, payload),
      registerHotkey: (accel, handler) => {
        const ok = globalShortcut.register(accel, handler);
        if (!ok) console.warn(`[plugins] hotkey failed: ${accel}`);
        return ok;
      },
      setCaptureHidden: (h) => mw!.setCaptureHidden(h),
      getCaptureHidden: () => mw!.getCaptureHidden(),
      setOpacity: (v) => mw!.setOpacity(v),
      getOpacity: () => mw!.getOpacity(),
      nudgeOpacity: (d) => mw!.nudgeOpacity(d),
    };

    const pluginInfos: PluginInfo[] = [];
    for (const plugin of activePlugins) {
      const { manifest } = plugin;
      if (manifest.surface) browser.addSurface(manifest.surface);
      pluginInfos.push({ id: manifest.id, title: manifest.title, surface: manifest.surface });
      try {
        void plugin.registerMain?.(ctx);
      } catch (err) {
        console.error(`[plugins] "${manifest.id}" registerMain failed:`, err);
      }
    }
    console.log(`[plugins] active: ${pluginInfos.map((p) => p.id).join(', ') || '(none)'}`);

    registerIpc(mw, browser, pluginInfos);
    registerShortcuts(browser);
    buildMenu(browser);
  };

  app.on('second-instance', () => {
    if (mw) {
      if (mw.win.isMinimized()) mw.win.restore();
      mw.win.focus();
    }
  });

  app.whenReady().then(() => {
    boot();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => unregisterShortcuts());
}
