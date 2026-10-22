import { globalShortcut, type WebContents } from 'electron';
import { JsonStore } from './store';
import { Event } from '../shared/ipc-contract';
import { canonical, isValidBinding, pressCanonical } from '../shared/keys';
import {
  COMMANDS,
  DEFAULT_MASTER_KEYS,
  DEFAULT_SHORTCUT_CONFIG,
  MASTER_ID,
  SHORTCUT_GROUPS,
  allBindables,
  commandDef,
  findOwner,
  groupActive,
  isCommandId,
  keysFor,
  type CommandId,
  type CustomShortcut,
  type ShortcutConfig,
  type ShortcutGroupId,
  type ShortcutsState,
} from '../shared/shortcuts';

const isMac = process.platform === 'darwin';

interface AppBinding {
  run: () => void;
  repeat: boolean;
  /** Built-in command behind this key (custom shortcuts have none). */
  id?: CommandId;
}

/**
 * Every keyboard shortcut in Bro, rebindable from Settings.
 *
 * Two kinds of dispatch:
 *  - GLOBAL (BroBrowsing group, system-wide custom shortcuts, the master
 *    switch) → globalShortcut, so they fire even when Bro isn't focused.
 *  - IN-APP (everything else) → `before-input-event` on every view we own,
 *    so they work wherever focus is inside Bro (tab, address bar, overlay)
 *    and can be rebound or switched off at runtime.
 *
 * The master switch (default Ctrl/Cmd+Shift+`) cuts off whichever groups you
 * pick, e.g. to hand Ctrl+Shift+H/S/O back to other apps. It is never cut off
 * itself, so the same key always brings them back.
 */
export class ShortcutManager {
  private store: JsonStore<ShortcutConfig>;
  private appKeys = new Map<string, AppBinding>();
  private failed: string[] = [];
  private recording = false;
  /** Fixed global hotkeys from plugins (MainContext.registerHotkey), re-bound on every apply(). */
  private extraGlobals: { accel: string; run: () => void }[] = [];
  /** Called after any binding change (the app menu re-reads accelFor). */
  onChange: () => void = () => {};

  constructor(
    private emit: (channel: string, payload: unknown) => void,
    private handlers: Record<CommandId, () => void>,
    private runCustom: (s: CustomShortcut) => void,
    /** False for commands whose plugin is not in this build (they are never bound). */
    private available: (id: CommandId) => boolean = () => true,
  ) {
    this.store = new JsonStore<ShortcutConfig>('shortcuts', DEFAULT_SHORTCUT_CONFIG);
    this.store.set(normalize(this.store.get()));
    this.apply();
  }

  get config(): ShortcutConfig {
    return this.store.get();
  }

  state(): ShortcutsState {
    return { config: this.config, failed: this.failed };
  }

  /**
   * Route a view's key presses through the in-app bindings. `leave` lists
   * commands whose keys this view keeps for itself (a plugin panel uses Ctrl+S
   * to save a request, not to "Save for offline" the tab behind it).
   */
  attach(wc: WebContents, leave: readonly CommandId[] = []): void {
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || this.recording) return;
      const key = pressCanonical(
        input.code,
        { ctrl: input.control, alt: input.alt, shift: input.shift, meta: input.meta },
        isMac,
      );
      const binding = key ? this.appKeys.get(key) : undefined;
      if (!binding || (binding.id && leave.includes(binding.id))) return;
      e.preventDefault(); // the page never sees a browser shortcut
      if (!input.isAutoRepeat || binding.repeat) binding.run();
    });
  }

  run(id: CommandId): void {
    if (this.available(id)) this.handlers[id]();
  }

  /** Is this command in the build (its plugin, if any, is active)? */
  isAvailable(id: CommandId): boolean {
    return this.available(id);
  }

  /** A plugin's fixed system-wide hotkey. Returns false if the OS refused it. */
  addGlobal(accel: string, run: () => void): boolean {
    this.extraGlobals.push({ accel, run });
    this.apply();
    return !this.failed.includes(accel);
  }

  /** First live key for a command — shown next to app-menu items. */
  accelFor(id: CommandId): string | undefined {
    if (!this.available(id) || !groupActive(this.config, commandDef(id).group)) return undefined;
    return keysFor(this.config, id)[0];
  }

  // --- Changes from Settings ----------------------------------------------

  setKeys(id: string, keys: string[]): void {
    const valid = dedupe(keys.filter((k) => isValidBinding(k, isMac)));
    this.store.update((cfg) => {
      let next = cfg;
      // One key does one thing: take it away from whatever had it before.
      for (const k of valid) next = withoutKey(next, k, id);
      return withKeys(next, id, valid);
    });
    this.apply();
  }

  /** Reset one binding to its default keys, or (no id) every shortcut setting. */
  reset(id?: string): void {
    if (id === MASTER_ID) return this.setKeys(id, [...DEFAULT_MASTER_KEYS]);
    if (id && isCommandId(id)) return this.setKeys(id, [...commandDef(id).keys]);
    if (id) return;
    // Full reset keeps your custom shortcuts, minus any key a default now needs.
    const base: ShortcutConfig = { ...DEFAULT_SHORTCUT_CONFIG, custom: [] };
    const custom = this.config.custom.map((c) => ({
      ...c,
      keys: c.keys.filter((k) => !findOwner(base, k, isMac)),
    }));
    this.store.set({ ...base, custom });
    this.apply();
  }

  setGroupEnabled(group: ShortcutGroupId, enabled: boolean): void {
    this.store.update((cfg) => ({ ...cfg, groupEnabled: { ...cfg.groupEnabled, [group]: enabled } }));
    this.apply();
  }

  setMasterTargets(groups: ShortcutGroupId[]): void {
    const valid = groups.filter((g) => SHORTCUT_GROUPS.some((x) => x.id === g));
    this.store.update((cfg) => ({ ...cfg, master: { ...cfg.master, targets: valid } }));
    this.apply();
  }

  toggleMaster(): void {
    this.store.update((cfg) => ({ ...cfg, master: { ...cfg.master, active: !cfg.master.active } }));
    this.apply();
  }

  saveCustom(s: CustomShortcut): void {
    const target = String(s.target ?? '').trim();
    if (!target) return;
    const entry: CustomShortcut = {
      id: s.id || `custom.${Date.now().toString(36)}`,
      label: String(s.label ?? '').trim() || target,
      target,
      keys: [],
      global: !!s.global,
      newTab: s.newTab !== false,
    };
    this.store.update((cfg) => {
      const i = cfg.custom.findIndex((c) => c.id === entry.id);
      const custom = [...cfg.custom];
      if (i >= 0) custom[i] = entry;
      else custom.push(entry);
      return { ...cfg, custom };
    });
    this.setKeys(entry.id, s.keys ?? []); // also steals the keys + applies
  }

  removeCustom(id: string): void {
    this.store.update((cfg) => ({ ...cfg, custom: cfg.custom.filter((c) => c.id !== id) }));
    this.apply();
  }

  /**
   * While Settings is capturing a new key combo, every hotkey is suspended
   * (global ones are unregistered) so the combo reaches the page instead of
   * firing — otherwise you couldn't record a key Bro already uses.
   */
  setRecording(on: boolean): void {
    if (on === this.recording) return;
    this.recording = on;
    this.apply();
  }

  importConfig(raw: unknown): void {
    this.store.set(normalize(raw as Partial<ShortcutConfig>));
    this.apply();
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.store.flush();
  }

  // --- Internals -----------------------------------------------------------

  private apply(): void {
    globalShortcut.unregisterAll();
    this.appKeys.clear();
    this.failed = [];
    const cfg = this.config;

    if (!this.recording) {
      // The master switch is always live, so it can always bring the rest back.
      for (const k of cfg.master.keys) this.bindGlobal(k, () => this.toggleMaster());
      for (const g of this.extraGlobals) this.bindGlobal(g.accel, g.run);

      for (const cmd of COMMANDS) {
        if (!this.available(cmd.id) || !groupActive(cfg, cmd.group)) continue;
        const global = SHORTCUT_GROUPS.find((g) => g.id === cmd.group)!.global;
        const repeat = 'repeat' in cmd && cmd.repeat;
        for (const k of keysFor(cfg, cmd.id)) this.bind(k, global, () => this.run(cmd.id), repeat, cmd.id);
      }

      if (groupActive(cfg, 'custom')) {
        for (const s of cfg.custom) {
          for (const k of s.keys) this.bind(k, s.global, () => this.runCustom(s), false);
        }
      }
    }

    this.emit(Event.ShortcutsChanged, this.state());
    this.onChange();
  }

  private bind(accel: string, global: boolean, run: () => void, repeat: boolean, id?: CommandId): void {
    if (global) return this.bindGlobal(accel, run);
    const key = canonical(accel, isMac);
    if (key) this.appKeys.set(key, { run, repeat, id });
  }

  private bindGlobal(accel: string, run: () => void): void {
    try {
      if (globalShortcut.register(accel, run)) return;
    } catch {
      /* malformed accelerator — reported below */
    }
    // Usually another app (or the OS) already owns this combo.
    this.failed.push(accel);
    console.warn(`[shortcuts] failed: ${accel}`);
  }
}

// --- Pure config helpers ----------------------------------------------------

function normalize(raw: Partial<ShortcutConfig> | undefined): ShortcutConfig {
  const d = DEFAULT_SHORTCUT_CONFIG;
  return {
    overrides: raw?.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
    custom: Array.isArray(raw?.custom) ? raw.custom : [],
    groupEnabled: raw?.groupEnabled && typeof raw.groupEnabled === 'object' ? raw.groupEnabled : {},
    master: { ...d.master, ...(raw?.master ?? {}) },
  };
}

function dedupe(keys: string[]): string[] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const c = canonical(k, isMac);
    if (!c || seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

function withKeys(cfg: ShortcutConfig, id: string, keys: string[]): ShortcutConfig {
  if (id === MASTER_ID) return { ...cfg, master: { ...cfg.master, keys } };
  if (cfg.custom.some((c) => c.id === id)) {
    return { ...cfg, custom: cfg.custom.map((c) => (c.id === id ? { ...c, keys } : c)) };
  }
  if (isCommandId(id)) return { ...cfg, overrides: { ...cfg.overrides, [id]: keys } };
  return cfg;
}

function withoutKey(cfg: ShortcutConfig, accel: string, exceptId: string): ShortcutConfig {
  const want = canonical(accel, isMac);
  let next = cfg;
  for (const b of allBindables(cfg)) {
    if (b.id === exceptId) continue;
    const keys = keysFor(next, b.id);
    const kept = keys.filter((k) => canonical(k, isMac) !== want);
    if (kept.length !== keys.length) next = withKeys(next, b.id, kept);
  }
  return next;
}
