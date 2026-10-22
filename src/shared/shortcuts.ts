// The shortcut registry: every built-in command, its group and default keys.
// Main dispatches from it; the Settings page renders + rebinds from it.
// Defaults follow the conventions Chrome, Edge, Firefox and Brave share.
import { canonical } from './keys';

export type ShortcutGroupId = 'brobrowsing' | 'tabs' | 'navigation' | 'page' | 'app' | 'custom';

export interface ShortcutGroup {
  id: ShortcutGroupId;
  name: string;
  description: string;
  /** System-wide (globalShortcut) instead of only while Bro is focused. */
  global: boolean;
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: 'brobrowsing',
    name: 'BroBrowsing',
    description: 'Stealth controls: screen-share invisibility, opacity, overlay, boss key. System-wide, so they work mid-meeting from any app.',
    global: true,
  },
  { id: 'tabs', name: 'Tabs', description: 'Open, close, reopen and switch tabs.', global: false },
  { id: 'navigation', name: 'Navigation', description: 'Back, forward, reload, address bar.', global: false },
  { id: 'page', name: 'Page', description: 'Find, zoom, full screen, print, developer tools.', global: false },
  { id: 'app', name: 'Bookmarks, sessions & app', description: 'Library, saved sessions and Settings.', global: false },
  {
    id: 'custom',
    name: 'My shortcuts',
    description: 'Your own keys that open a site or run a search (e.g. "yt lofi"). Each one can be in-app or system-wide.',
    global: false,
  },
];

interface CommandDef {
  id: string;
  label: string;
  group: Exclude<ShortcutGroupId, 'custom'>;
  keys: readonly string[];
  /** Keep firing while the key is held (zoom, tab cycling, opacity). */
  repeat?: boolean;
  /** Only exists when this plugin is in the build (otherwise never bound or shown). */
  plugin?: string;
}

export const COMMANDS = [
  // --- BroBrowsing (global) ------------------------------------------------
  { id: 'stealth.toggleCapture', label: 'Toggle screen-share invisibility', group: 'brobrowsing', keys: ['CommandOrControl+Shift+H'], plugin: 'overlay-hiding' },
  { id: 'stealth.opacityUp', label: 'Opacity up', group: 'brobrowsing', keys: ['CommandOrControl+Shift+]'], repeat: true, plugin: 'opacity' },
  { id: 'stealth.opacityDown', label: 'Opacity down', group: 'brobrowsing', keys: ['CommandOrControl+Shift+['], repeat: true, plugin: 'opacity' },
  { id: 'stealth.opacityReset', label: 'Reset opacity to solid', group: 'brobrowsing', keys: ['CommandOrControl+Shift+\\'], plugin: 'opacity' },
  { id: 'stealth.toggleOverlay', label: 'Overlay mode (click-through + on top)', group: 'brobrowsing', keys: ['CommandOrControl+Shift+O'] },
  { id: 'stealth.bossKey', label: 'Boss key: hide / show Bro instantly', group: 'brobrowsing', keys: ['CommandOrControl+Alt+B'] },
  { id: 'stealth.toggleSettings', label: 'Open / close Settings', group: 'brobrowsing', keys: ['CommandOrControl+Shift+S'] },

  // --- Tabs ----------------------------------------------------------------
  { id: 'tab.new', label: 'New tab', group: 'tabs', keys: ['CommandOrControl+T'] },
  { id: 'tab.newPrivate', label: 'New private tab', group: 'tabs', keys: ['CommandOrControl+Shift+N'] },
  { id: 'tab.close', label: 'Close tab', group: 'tabs', keys: ['CommandOrControl+W', 'CommandOrControl+F4'] },
  { id: 'tab.reopenClosed', label: 'Reopen closed tab', group: 'tabs', keys: ['CommandOrControl+Shift+T'] },
  { id: 'tab.duplicate', label: 'Duplicate tab', group: 'tabs', keys: ['Alt+Shift+D'] },
  { id: 'tab.next', label: 'Next tab', group: 'tabs', keys: ['CommandOrControl+Tab', 'CommandOrControl+PageDown'], repeat: true },
  { id: 'tab.prev', label: 'Previous tab', group: 'tabs', keys: ['CommandOrControl+Shift+Tab', 'CommandOrControl+PageUp'], repeat: true },
  { id: 'tab.goto1', label: 'Go to tab 1', group: 'tabs', keys: ['CommandOrControl+1'] },
  { id: 'tab.goto2', label: 'Go to tab 2', group: 'tabs', keys: ['CommandOrControl+2'] },
  { id: 'tab.goto3', label: 'Go to tab 3', group: 'tabs', keys: ['CommandOrControl+3'] },
  { id: 'tab.goto4', label: 'Go to tab 4', group: 'tabs', keys: ['CommandOrControl+4'] },
  { id: 'tab.goto5', label: 'Go to tab 5', group: 'tabs', keys: ['CommandOrControl+5'] },
  { id: 'tab.goto6', label: 'Go to tab 6', group: 'tabs', keys: ['CommandOrControl+6'] },
  { id: 'tab.goto7', label: 'Go to tab 7', group: 'tabs', keys: ['CommandOrControl+7'] },
  { id: 'tab.goto8', label: 'Go to tab 8', group: 'tabs', keys: ['CommandOrControl+8'] },
  { id: 'tab.gotoLast', label: 'Go to last tab', group: 'tabs', keys: ['CommandOrControl+9'] },

  // --- Navigation ----------------------------------------------------------
  { id: 'nav.back', label: 'Back', group: 'navigation', keys: ['Alt+Left'] },
  { id: 'nav.forward', label: 'Forward', group: 'navigation', keys: ['Alt+Right'] },
  { id: 'nav.reload', label: 'Reload', group: 'navigation', keys: ['CommandOrControl+R', 'F5'] },
  { id: 'nav.hardReload', label: 'Hard reload (bypass cache)', group: 'navigation', keys: ['CommandOrControl+Shift+R', 'CommandOrControl+F5', 'Shift+F5'] },
  { id: 'nav.focusAddress', label: 'Focus address bar', group: 'navigation', keys: ['CommandOrControl+L', 'Alt+D', 'F6'] },
  { id: 'nav.home', label: 'Home (start page)', group: 'navigation', keys: ['Alt+Home'] },

  // --- Page ----------------------------------------------------------------
  { id: 'page.find', label: 'Find in page', group: 'page', keys: ['CommandOrControl+F'] },
  { id: 'page.findNext', label: 'Find next', group: 'page', keys: ['F3', 'CommandOrControl+G'], repeat: true },
  { id: 'page.findPrev', label: 'Find previous', group: 'page', keys: ['Shift+F3', 'CommandOrControl+Shift+G'], repeat: true },
  { id: 'page.zoomIn', label: 'Zoom in', group: 'page', keys: ['CommandOrControl+=', 'CommandOrControl+Shift+=', 'CommandOrControl+numadd'], repeat: true },
  { id: 'page.zoomOut', label: 'Zoom out', group: 'page', keys: ['CommandOrControl+-', 'CommandOrControl+numsub'], repeat: true },
  { id: 'page.zoomReset', label: 'Reset zoom', group: 'page', keys: ['CommandOrControl+0', 'CommandOrControl+num0'] },
  { id: 'page.fullscreen', label: 'Full screen', group: 'page', keys: ['F11'] },
  { id: 'page.print', label: 'Print', group: 'page', keys: ['CommandOrControl+P'] },
  { id: 'page.viewSource', label: 'View page source', group: 'page', keys: ['CommandOrControl+U'] },
  { id: 'page.devtools', label: 'Developer tools', group: 'page', keys: ['F12', 'CommandOrControl+Shift+I'] },
  { id: 'page.saveOffline', label: 'Save page + video for offline', group: 'page', keys: ['CommandOrControl+S'] },

  // --- App -----------------------------------------------------------------
  { id: 'app.bookmark', label: 'Bookmark this page', group: 'app', keys: ['CommandOrControl+D'] },
  { id: 'app.library', label: 'Bookmarks & History', group: 'app', keys: ['CommandOrControl+Y'] },
  { id: 'app.history', label: 'History', group: 'app', keys: ['CommandOrControl+H'] },
  { id: 'app.downloads', label: 'Downloads (opens in a tab)', group: 'app', keys: ['CommandOrControl+J'] },
  { id: 'app.offline', label: 'Offline videos (opens in a tab)', group: 'app', keys: ['CommandOrControl+Shift+J'] },
  { id: 'app.saveSession', label: 'Save all tabs as a session', group: 'app', keys: ['CommandOrControl+Shift+D'] },
  { id: 'app.settings', label: 'Settings', group: 'app', keys: ['CommandOrControl+,'] },
] as const satisfies readonly CommandDef[];

export type CommandId = (typeof COMMANDS)[number]['id'];

export const MASTER_ID = 'master';
export const DEFAULT_MASTER_KEYS = ['CommandOrControl+Shift+`'];

/** A user-defined shortcut: opens a URL, or runs a search like "yt lofi". */
export interface CustomShortcut {
  id: string;
  label: string;
  target: string;
  keys: string[];
  global: boolean;
  newTab: boolean;
}

export interface ShortcutConfig {
  /** Command id → keys, replacing that command's defaults. */
  overrides: Record<string, string[]>;
  custom: CustomShortcut[];
  /** Per-group on/off switch. Missing = on. */
  groupEnabled: Partial<Record<ShortcutGroupId, boolean>>;
  /**
   * The master switch: its keys (always system-wide, never cut off), which
   * groups it cuts off, and whether the cut-off is currently in effect.
   */
  master: { keys: string[]; targets: ShortcutGroupId[]; active: boolean };
}

export const DEFAULT_SHORTCUT_CONFIG: ShortcutConfig = {
  overrides: {},
  custom: [],
  groupEnabled: {},
  master: { keys: DEFAULT_MASTER_KEYS, targets: ['brobrowsing'], active: false },
};

export interface ShortcutsState {
  config: ShortcutConfig;
  /** Global accelerators the OS refused (usually: another app already owns them). */
  failed: string[];
}

export function isCommandId(id: string): id is CommandId {
  return COMMANDS.some((c) => c.id === id);
}

export function commandDef(id: CommandId) {
  return COMMANDS.find((c) => c.id === id)!;
}

/** The plugin a command belongs to (undefined = core, always available). */
export function commandPlugin(id: CommandId): string | undefined {
  const c = commandDef(id);
  return 'plugin' in c ? c.plugin : undefined;
}

/** Is this command part of a build with these plugin ids? */
export function commandAvailable(id: CommandId, pluginIds: ReadonlySet<string>): boolean {
  const p = commandPlugin(id);
  return !p || pluginIds.has(p);
}

/** Effective keys for a command, custom shortcut, or the master switch. */
export function keysFor(cfg: ShortcutConfig, id: string): readonly string[] {
  if (id === MASTER_ID) return cfg.master.keys;
  const custom = cfg.custom.find((c) => c.id === id);
  if (custom) return custom.keys;
  if (cfg.overrides[id]) return cfg.overrides[id];
  return isCommandId(id) ? commandDef(id).keys : [];
}

/** Is this group live right now (its own switch on, and not cut off by the master)? */
export function groupActive(cfg: ShortcutConfig, group: ShortcutGroupId): boolean {
  if (cfg.groupEnabled[group] === false) return false;
  return !(cfg.master.active && cfg.master.targets.includes(group));
}

/** Every bindable id with a display label, for conflict messages. */
export function allBindables(cfg: ShortcutConfig): { id: string; label: string }[] {
  return [
    { id: MASTER_ID, label: 'Master switch' },
    ...COMMANDS.map((c) => ({ id: c.id as string, label: c.label as string })),
    ...cfg.custom.map((c) => ({ id: c.id, label: c.label })),
  ];
}

/** Which binding (other than `exceptId`) already uses this key, if any. */
export function findOwner(
  cfg: ShortcutConfig,
  accel: string,
  isMac: boolean,
  exceptId?: string,
): { id: string; label: string } | null {
  const want = canonical(accel, isMac);
  if (!want) return null;
  for (const b of allBindables(cfg)) {
    if (b.id === exceptId) continue;
    if (keysFor(cfg, b.id).some((k) => canonical(k, isMac) === want)) return b;
  }
  return null;
}
