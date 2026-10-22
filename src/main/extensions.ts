import { app, type BrowserWindow, type ContextMenuParams, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import { installChromeWebStore } from 'electron-chrome-web-store';
import type { TabManager } from './tabs';

/**
 * Full Chrome-extension support, including installing straight from the Chrome
 * Web Store — one extension system per profile, created the first time the
 * profile is used.
 *
 *  - `ElectronChromeExtensions` implements the chrome.* APIs (tabs, windows,
 *    browserAction, contextMenus, storage, …) on top of our tabs.
 *  - `installChromeWebStore` injects the "Add to Chrome" flow on
 *    chromewebstore.google.com and loads previously-installed extensions.
 *
 * The default profile keeps extensions in userData/Extensions (where they've
 * always been); other profiles get <their partition folder>/Extensions.
 * Private tabs are never registered (TabManager skips the hooks for them).
 *
 * NOTE: electron-chrome-extensions is distributed under GPL-3.0 (the license we
 * pass below). Keep that in mind for distribution.
 */
export class Extensions {
  private readonly byProfile = new Map<string, ElectronChromeExtensions>();

  constructor(
    private win: BrowserWindow,
    private tabs: TabManager,
    private sessionFor: (profileId: string) => Session,
  ) {
    // Keep each profile's extension system in sync with its tabs.
    this.tabs.hooks = {
      onCreated: (wc, p) => this.ensure(p).addTab(wc, this.win),
      onActivated: (wc, p) => this.ensure(p).selectTab(wc),
      onRemoved: (wc, p) => this.byProfile.get(p)?.removeTab(wc),
    };
  }

  /** The extension system for a profile — created (and its extensions loaded) on first use. */
  ensure(profileId: string): ElectronChromeExtensions {
    const existing = this.byProfile.get(profileId);
    if (existing) return existing;

    const sess = this.sessionFor(profileId);
    const api = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: sess,
      // chrome.tabs.create → open a real tab in this profile and hand back its webContents.
      createTab: async (details) => {
        const id = this.tabs.newTab(details.url ?? undefined, { profileId });
        const wc = this.tabs.webContentsFor(id);
        if (!wc) throw new Error('failed to create tab');
        return [wc, this.win];
      },
      // chrome.tabs.update({active}) / windows focus → activate that tab.
      selectTab: (tab) => {
        // Echo of a tab we're creating ourselves — TabManager decides what's active.
        if (this.tabs.isCreating) return;
        const id = this.tabs.idForWebContents(tab);
        if (id != null) this.tabs.activate(id);
      },
      // chrome.tabs.remove → close that tab.
      removeTab: (tab) => {
        const id = this.tabs.idForWebContents(tab);
        if (id != null) this.tabs.closeTab(id);
      },
      // We run a single window; hand it back for chrome.windows.create.
      createWindow: async () => this.win,
      removeWindow: () => {
        /* never close the main window on extension request */
      },
    });
    // Needed so <browser-action-list> toolbar icons (crx:// URLs) resolve.
    ElectronChromeExtensions.handleCRXProtocol(sess);
    this.byProfile.set(profileId, api);

    void installChromeWebStore({
      session: sess,
      extensionsPath: profileId === 'default' ? join(app.getPath('userData'), 'Extensions') : join(sess.getStoragePath() ?? app.getPath('userData'), 'Extensions'),
      loadExtensions: true,          // restore installed extensions
      allowUnpackedExtensions: true, // allow loading unpacked dev extensions too
    }).catch((e) => console.error(`[extensions] Chrome Web Store setup failed (${profileId})`, e));
    return api;
  }

  /** Start the default profile's extensions at launch. */
  async init(): Promise<void> {
    this.ensure('default');
  }

  getContextMenuItems(profileId: string, wc: WebContents, params: ContextMenuParams): Electron.MenuItem[] {
    const api = this.byProfile.get(profileId);
    try {
      return api ? api.getContextMenuItems(wc, params) : [];
    } catch (e) {
      console.warn('[extensions] context menu items failed', e); // never block the menu itself
      return [];
    }
  }
}
