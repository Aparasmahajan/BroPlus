import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { Browser } from './browser';

/**
 * Application menu. Its accelerators are the browser's keyboard shortcuts —
 * unlike globalShortcut, these fire only when Bro is focused, which is the
 * correct behaviour for Ctrl/Cmd+T, +W, +L, etc. (The signature-feature keys
 * stay global; see shortcuts.ts.) On Windows the menu bar is hidden but the
 * accelerators remain active; on macOS it shows in the system menu bar.
 */
export function buildMenu(browser: Browser): void {
  const isMac = process.platform === 'darwin';
  const tabs = browser.tabs;

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => tabs.newTab() },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => tabs.closeTab(currentActive(tabs)) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => tabs.reload() },
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => browser.focusOmnibox() },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => browser.toggleSettings() },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'editMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function currentActive(tabs: Browser['tabs']): number {
  return tabs.list().find((t) => t.active)?.id ?? -1;
}
