// The plugin contract (ARCHITECTURE.md §A — Plugin system).
//
// Bro_plus is a small CORE (browser shell: window, tabs, omnibox, plugin host)
// plus feature PLUGINS. Every headline feature — screen-share hiding, opacity,
// the Postman-class API client, the Burp-class proxy, ad-block, diff — is a
// plugin. Which plugins ship is chosen at BUILD time (plugins.config.json or the
// BRO_PLUGINS env var): excluded plugins are never imported, so their code is
// tree-shaken out of the bundle (see esbuild.mjs codegen).
//
// A plugin can contribute three kinds of thing:
//   • a SURFACE   — a top-level mode with its own panel (API, Proxy).
//   • a CAPABILITY — behavior with no surface of its own (overlay hiding,
//                    opacity, ad-block); usually it adds IPC + hotkeys and may
//                    render into the shared Settings page.
//   • a LIBRARY   — pure code other plugins depend on (diff); no registerMain
//                    side effects, just exports.

import type { App, BrowserWindow, IpcMain, Session } from 'electron';

/** A top-level mode a plugin contributes (shown in the chrome mode switch). */
export interface SurfaceSpec {
  /** Unique mode id, e.g. 'api' or 'proxy'. 'browse' is the core default. */
  mode: string;
  /** Button label in the mode switch. */
  label: string;
  /** Published panel HTML filename in dist/ui, e.g. 'api-client.html'. */
  html: string;
}

export interface PluginManifest {
  id: string;
  title: string;
  description: string;
  /** Plugin ids this one needs; the build fails if enabled without them. */
  dependsOn?: string[];
  /** Present if the plugin adds a top-level surface. */
  surface?: SurfaceSpec;
}

/** What the chrome/settings UIs learn about an active plugin (via plugins:list). */
export interface PluginInfo {
  id: string;
  title: string;
  surface?: SurfaceSpec;
}

/** Which browsing session a hook is being told about (see MainContext.onSession). */
export interface SessionInfo {
  /** The shared in-memory session private tabs use. */
  private: boolean;
  /** Profile the session belongs to ('default' for the original one and for private tabs). */
  profileId: string;
  /** Electron partition ('' = the default session). */
  partition: string;
}

/** Everything a plugin's main-process code is handed at registration. */
export interface MainContext {
  app: App;
  /** The one native window (frameless, content-protectable, opacity-capable). */
  win: BrowserWindow;
  ipc: IpcMain;
  /** The shared Electron session (default profile: cookies seen by tabs + API + proxy). */
  session: Session;
  /**
   * Run for EVERY session browser tabs use — the default one, each profile's and
   * the private one — now for those already in use and later for each new one
   * (e.g. ad blocking has to cover all of them).
   */
  onSession(hook: (s: Session, info: SessionInfo) => void): void;
  /** Run for the main window now, and for any window re-created later (macOS dock re-open). */
  onWindow(hook: (win: BrowserWindow) => void): void;
  /** Run once the window is up and the first tabs exist — for slow, deferrable work. */
  onStarted(hook: () => void): void;
  /** Portable config root (BRO_PLUS_CONFIG_DIR override, else userData). */
  configDir: string;

  /** Open a URL in a new browser tab (and show the Browse surface). */
  openTab(url: string): void;

  /**
   * Tiny service registry so plugins can cooperate without importing each
   * other: e.g. the proxy provides 'proxy' ({ running, port, caPem }) and the API
   * client looks it up to "send through the proxy". lookup() returns undefined
   * when the providing plugin is not in this build.
   */
  provide<T>(name: string, service: T): void;
  lookup<T>(name: string): T | undefined;

  /** Send an event to every trusted UI view (chrome, settings, all panels). */
  sendToUi(channel: string, payload?: unknown): void;
  /**
   * Register a fixed system-wide hotkey (kept across shortcut re-binds, released
   * on quit). Returns false if the OS refused it. For a key users should be able
   * to rebind, add a command tagged with this plugin's id to the registry in
   * shared/shortcuts.ts instead.
   */
  registerHotkey(accel: string, handler: () => void): boolean;

  // --- Core window capabilities plugins drive (overlay/opacity use these) ---
  setCaptureHidden(hidden: boolean): void;
  getCaptureHidden(): boolean;
  setOpacity(value: number): void;
  getOpacity(): number;
  nudgeOpacity(delta: number): void;
}

/** A plugin module's default export shape. */
export interface BroPlugin {
  manifest: PluginManifest;
  /** Wire IPC, engines, hotkeys, defaults. Omitted for pure library plugins. */
  registerMain?(ctx: MainContext): void | Promise<void>;
}
