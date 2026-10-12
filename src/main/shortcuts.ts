import { globalShortcut } from 'electron';
import type { Browser } from './browser';

/**
 * CORE global hotkeys only. Feature hotkeys (Ctrl/Cmd+Shift+H for screen-share
 * hiding, Ctrl/Cmd+Shift+] / [ for opacity) are now owned by their PLUGINS and
 * registered via MainContext.registerHotkey, so they come and go with the build.
 * globalShortcut.unregisterAll() on quit covers plugin hotkeys too.
 *
 *   Ctrl/Cmd+Shift+S   open/close Settings
 */
export function registerShortcuts(browser: Browser): void {
  const bind = (accel: string, fn: () => void) => {
    if (!globalShortcut.register(accel, fn)) console.warn(`[shortcuts] failed: ${accel}`);
  };

  bind('CommandOrControl+Shift+S', () => browser.toggleSettings());
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
