import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { autoUpdater } from 'electron-updater';

/**
 * Auto-update via electron-updater. Only runs in a packaged, production build
 * that actually has an update feed. The `app-update.yml` descriptor is baked in
 * by electron-builder for installer targets (nsis/dmg) but NOT for `--dir`
 * builds, so we check for it first to avoid a spurious error there.
 */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return;
  const feed = join(process.resourcesPath, 'app-update.yml');
  if (!existsSync(feed)) return; // --dir build or no publish config

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[updater]', e));
}
