import { app, BrowserWindow, components, ipcMain, session } from 'electron';
import { MainWindow } from './window';
import { Browser } from './browser';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { initAutoUpdate } from './updater';
import type { MainContext, PluginInfo } from '../core/plugin';
import { activePlugins } from '../generated/active-plugins';

// Portable install (e.g. a USB stick): keep ALL state — Chromium's profile,
// cookies, extensions, Bro's JSON stores, API collections, the proxy CA — in one
// folder. Must happen before 'ready'.
const portableDir = process.env.BRO_PLUS_CONFIG_DIR?.trim();
if (portableDir) app.setPath('userData', portableDir);

// Look like plain Chrome (as Brave does): sites such as Netflix and Google sign-in turn
// away user agents carrying "Electron/…" or an unknown app token.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|bro-plus|bro-browser)\/\S+/g, '');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mw: MainWindow | null = null;
  let browser: Browser | null = null;
  let pluginsRegistered = false;
  // Plugin hooks live here, not on one Browser: on macOS a closed window is
  // re-booted with a fresh Browser + MainWindow, and every hook is replayed there.
  const hooks = {
    window: [] as ((win: BrowserWindow) => void)[],
    session: [] as Parameters<MainContext['onSession']>[0][],
    started: [] as (() => void)[],
  };
  const services = new Map<string, unknown>();
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.error('[plugins] hook failed', e);
    }
  };
  const applyHooks = (b: Browser, w: MainWindow) => {
    for (const h of hooks.window) safe(() => h(w.win));
    for (const h of hooks.session) b.onSession(h);
    for (const h of hooks.started) b.onStarted(h);
  };

  const pluginIds = new Set(activePlugins.map((p) => p.manifest.id));
  const pluginInfos: PluginInfo[] = activePlugins.map(({ manifest }) => ({
    id: manifest.id,
    title: manifest.title,
    surface: manifest.surface,
  }));

  /**
   * Plugin host (ARCHITECTURE.md §A): add every build-selected plugin's surface
   * to the browser and let it wire its IPC/engines/hotkeys through MainContext.
   * Plugins register process-wide IPC, so this runs once per app run; on macOS a
   * re-booted window is re-bound through the getters and the replayed hooks.
   */
  const registerPlugins = (b: Browser, w: MainWindow) => {
    for (const { manifest } of activePlugins) if (manifest.surface) b.addSurface(manifest.surface);
    if (pluginsRegistered) return applyHooks(b, w);
    pluginsRegistered = true;

    const ctx: MainContext = {
      app,
      get win() {
        return (mw ?? w).win;
      },
      ipc: ipcMain,
      session: session.defaultSession,
      configDir: app.getPath('userData'),
      onWindow: (hook) => {
        hooks.window.push(hook);
        safe(() => hook((mw ?? w).win));
      },
      onSession: (hook) => {
        hooks.session.push(hook);
        (browser ?? b).onSession(hook);
      },
      onStarted: (hook) => {
        hooks.started.push(hook);
        (browser ?? b).onStarted(hook);
      },
      sendToUi: (channel, payload) => browser?.send(channel, payload),
      openTab: (url) => (browser ?? b).tabs.newTab(url),
      provide: (name, service) => void services.set(name, service),
      lookup: <T,>(name: string) => services.get(name) as T | undefined,
      registerHotkey: (accel, handler) => {
        const ok = (browser ?? b).shortcuts.addGlobal(accel, handler);
        if (!ok) console.warn(`[plugins] hotkey failed: ${accel}`);
        return ok;
      },
      setCaptureHidden: (h) => (mw ?? w).setCaptureHidden(h),
      getCaptureHidden: () => (mw ?? w).getCaptureHidden(),
      setOpacity: (v) => (mw ?? w).setOpacity(v),
      getOpacity: () => (mw ?? w).getOpacity(),
      nudgeOpacity: (d) => (mw ?? w).nudgeOpacity(d),
    };

    for (const plugin of activePlugins) {
      try {
        const r = plugin.registerMain?.(ctx);
        if (r instanceof Promise) r.catch((err) => console.error(`[plugins] "${plugin.manifest.id}" failed:`, err));
      } catch (err) {
        console.error(`[plugins] "${plugin.manifest.id}" registerMain failed:`, err);
      }
    }
    console.log(`[plugins] active: ${[...pluginIds].join(', ') || '(none)'}`);
  };

  const boot = () => {
    const w = new MainWindow();
    const b = new Browser(w, pluginIds);
    mw = w;
    browser = b;
    registerPlugins(b, w);
    registerIpc(w, b, pluginInfos);
    buildMenu(b);
    b.shortcuts.onChange = () => buildMenu(b); // keep menu labels in sync with rebinding
    // macOS keeps running without a window; save + release hotkeys now so a
    // later re-boot starts clean.
    w.win.on('closed', () => {
      b.flush();
      if (browser === b) browser = null;
      if (mw === w) mw = null;
    });
  };

  app.on('second-instance', () => {
    if (mw) {
      if (!mw.win.isVisible()) mw.win.show(); // hidden by the boss key
      if (mw.win.isMinimized()) mw.win.restore();
      mw.win.focus();
    }
  });

  // castlabs Electron fetches the Widevine CDM on first launch; a page that loads
  // before it is ready sees no DRM at all. Wait for it, but never for long.
  const widevine = () =>
    Promise.race([
      components.whenReady().then(
        () => undefined,
        (e: unknown) => console.warn('[bro] Widevine not available:', e),
      ),
      new Promise<void>((r) => setTimeout(r, 15_000)),
    ]);

  app.whenReady().then(async () => {
    await widevine();
    boot();
    initAutoUpdate();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
      else if (mw && !mw.win.isVisible()) mw.win.show(); // dock click after the boss key
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    browser?.flush();
  });
}
