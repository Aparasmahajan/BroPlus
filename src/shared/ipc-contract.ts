// Single source of truth for CORE IPC (window, tabs, settings, mode switch,
// plugin list) plus the GENERIC plugin bus. Plugins define their own channel
// strings and call them through `window.bro.plugin.*`, so the preload bridge
// stays static while the set of features varies per build.

import type { PluginInfo } from '../core/plugin';

export type { PluginInfo, SurfaceSpec } from '../core/plugin';
export type { HttpExchange, HttpRequest, HttpResponse, Header, HttpBody, Mode } from './http-model';

/** Renderer → main (core only; plugins use the generic bus). */
export const Channel = {
  // Frameless window controls.
  WindowMinimize: 'window:minimize',
  WindowMaximizeToggle: 'window:maximize-toggle',
  WindowClose: 'window:close',

  // Tabs / navigation (browser shell is core).
  TabNew: 'tab:new',
  TabClose: 'tab:close',
  TabActivate: 'tab:activate',
  TabNavigate: 'tab:navigate',
  TabBack: 'tab:back',
  TabForward: 'tab:forward',
  TabReload: 'tab:reload',
  TabStop: 'tab:stop',
  TabList: 'tab:list',

  // Settings overlay (a core shell; plugins render sections into it).
  SettingsToggle: 'settings:toggle',
  SettingsClose: 'settings:close',

  // Surface mode switch.
  ModeSet: 'mode:set',          // payload: Mode (surface id, or 'browse')

  // Plugin host.
  PluginsList: 'plugins:list',  // invoke → PluginInfo[]
} as const;

/** Main → renderer (core events; plugins emit their own channels via the bus). */
export const Event = {
  MaximizedChanged: 'evt:maximized-changed',
  TabsChanged: 'evt:tabs-changed',
  FocusOmnibox: 'evt:focus-omnibox',
  ModeChanged: 'evt:mode-changed',
} as const;

export interface TabState {
  id: number;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon?: string;
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

  setMode(mode: string): void;
  activePlugins(): Promise<PluginInfo[]>;

  onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
  onTabsChanged(cb: (tabs: TabState[]) => void): () => void;
  onFocusOmnibox(cb: () => void): () => void;
  onModeChanged(cb: (mode: string) => void): () => void;

  /** Generic bus for plugin UIs. */
  readonly plugin: PluginBus;

  readonly platform: NodeJS.Platform;
}

declare global {
  interface Window {
    bro: BroApi;
  }
}
