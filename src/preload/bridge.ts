import { contextBridge, ipcRenderer } from 'electron';
import {
  Channel,
  Event,
  type BroApi,
  type NavigatePayload,
  type PluginInfo,
  type TabState,
} from '../shared/ipc-contract';

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: BroApi = {
  minimize: () => ipcRenderer.send(Channel.WindowMinimize),
  toggleMaximize: () => ipcRenderer.send(Channel.WindowMaximizeToggle),
  close: () => ipcRenderer.send(Channel.WindowClose),

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

  setMode: (mode) => ipcRenderer.send(Channel.ModeSet, mode),
  activePlugins: () => ipcRenderer.invoke(Channel.PluginsList) as Promise<PluginInfo[]>,

  onMaximizedChanged: (cb) => on<boolean>(Event.MaximizedChanged, cb),
  onTabsChanged: (cb) => on<TabState[]>(Event.TabsChanged, cb),
  onFocusOmnibox: (cb) => on<void>(Event.FocusOmnibox, () => cb()),
  onModeChanged: (cb) => on<string>(Event.ModeChanged, cb),

  // Generic bus: how every plugin UI reaches its main-process half. Only trusted
  // views (chrome/settings/panels) receive this preload, so web content can't
  // use it. Plugins own their channel-name discipline.
  plugin: {
    invoke: <T = unknown>(channel: string, ...args: unknown[]) =>
      ipcRenderer.invoke(channel, ...args) as Promise<T>,
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
    on: <T = unknown>(channel: string, cb: (payload: T) => void) => on<T>(channel, cb),
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld('bro', api);
