import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { Browser } from './browser';
import type { CommandId } from '../shared/shortcuts';

/**
 * Application menu. Every shortcut is dispatched by ShortcutManager, so the
 * menu only DISPLAYS the current binding (registerAccelerator: false) — that
 * way a rebound or switched-off key can never fire twice or from a stale
 * binding. Rebuilt whenever the bindings change. On Windows the menu bar is
 * hidden (frameless window); on macOS it shows in the system menu bar.
 */
export function buildMenu(browser: Browser): void {
  const isMac = process.platform === 'darwin';
  const sc = browser.shortcuts;

  const item = (id: CommandId, label: string): MenuItemConstructorOptions => ({
    label,
    accelerator: sc.accelFor(id),
    visible: sc.isAvailable(id), // plugin-owned commands vanish with their plugin
    registerAccelerator: false,
    click: () => sc.run(id),
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        item('tab.new', 'New Tab'),
        item('tab.newPrivate', 'New Private Tab'),
        item('tab.reopenClosed', 'Reopen Closed Tab'),
        item('tab.close', 'Close Tab'),
        { type: 'separator' },
        item('app.saveSession', 'Save All Tabs as Session'),
        item('page.print', 'Print…'),
        { type: 'separator' },
        // Cmd+W belongs to "Close Tab"; close the window with Cmd+Shift+W like Chrome.
        isMac ? { role: 'close', accelerator: 'Command+Shift+W' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        item('nav.reload', 'Reload'),
        item('nav.focusAddress', 'Focus Address Bar'),
        item('page.find', 'Find in Page'),
        { type: 'separator' },
        item('page.zoomIn', 'Zoom In'),
        item('page.zoomOut', 'Zoom Out'),
        item('page.zoomReset', 'Actual Size'),
        item('page.fullscreen', 'Full Screen'),
        { type: 'separator' },
        item('page.viewSource', 'View Page Source'),
        item('page.devtools', 'Developer Tools'),
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        item('app.bookmark', 'Bookmark This Page'),
        item('app.library', 'Bookmarks & History'),
        item('app.history', 'History'),
        item('app.downloads', 'Downloads'),
        item('app.offline', 'Offline Videos'),
      ],
    },
    {
      label: 'Bro',
      submenu: [
        item('stealth.toggleCapture', 'Toggle Screen-Share Invisibility'),
        item('stealth.toggleOverlay', 'Toggle Overlay Mode'),
        item('stealth.bossKey', 'Hide Bro (Boss Key)'),
        { type: 'separator' },
        item('app.settings', 'Settings'),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
