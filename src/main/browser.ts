import { WebContentsView } from 'electron';
import { join } from 'node:path';
import type { MainWindow } from './window';
import { CHROME_H } from './window';
import { TabManager } from './tabs';
import { Event } from '../shared/ipc-contract';
import type { SurfaceSpec } from '../core/plugin';

const PRELOAD = join(__dirname, '../preload/bridge.js');
const UI_DIR = join(__dirname, '../ui');
const CHROME_HTML = join(UI_DIR, 'index.html');
const SETTINGS_HTML = join(UI_DIR, 'settings.html');

interface Surface {
  spec: SurfaceSpec;
  view?: WebContentsView; // created lazily on first switch
}

/**
 * Assembles the window: a top chrome bar (tabs + toolbar + mode switch), the tab
 * content area, a Settings overlay, and zero-or-more PLUGIN SURFACES (API, Proxy)
 * registered at boot. Exactly one surface is visible at a time — 'browse' shows
 * the tabs; any other mode shows that plugin's panel over the tab region. Every
 * trusted view (chrome, settings, panels) gets the privileged preload; web
 * content (tabs) does not.
 */
export class Browser {
  private readonly chrome: WebContentsView;
  private readonly settings: WebContentsView;
  readonly tabs: TabManager;
  private settingsOpen = false;

  private readonly surfaces = new Map<string, Surface>();
  private mode = 'browse';

  constructor(private mw: MainWindow) {
    const win = mw.win;

    this.chrome = this.makeView(CHROME_HTML);
    this.settings = this.makeView(SETTINGS_HTML);
    this.settings.setVisible(false);

    this.tabs = new TabManager(win, () => this.tabRegion(), (ch, p) => this.send(ch, p));

    // Route the window's core events (maximize) to the UI views.
    mw.emit = (ch, p) => this.send(ch, p);

    win.on('resize', () => this.layout());

    this.chrome.webContents.once('did-finish-load', () => {
      this.tabs.newTab();
      this.layout();
      win.show();
    });
  }

  // --- Plugin surfaces -----------------------------------------------------

  /** Called by the plugin host for every plugin whose manifest has a surface. */
  addSurface(spec: SurfaceSpec): void {
    this.surfaces.set(spec.mode, { spec });
  }

  surfaceList(): SurfaceSpec[] {
    return [...this.surfaces.values()].map((s) => s.spec);
  }

  setMode(mode: string): void {
    this.mode = mode;
    if (this.settingsOpen) this.closeSettings();

    for (const [id, s] of this.surfaces) {
      const on = id === mode;
      if (on && !s.view) {
        s.view = this.makeView(join(UI_DIR, s.spec.html));
      }
      if (s.view) {
        if (on) {
          this.mw.win.contentView.addChildView(s.view); // raise
          s.view.setBounds(this.tabRegion());
        }
        s.view.setVisible(on);
      }
    }

    if (mode === 'browse') this.tabs.layout();
    this.send(Event.ModeChanged, mode);
  }

  getMode(): string {
    return this.mode;
  }

  // --- Settings overlay ----------------------------------------------------

  toggleSettings(): void {
    this.settingsOpen ? this.closeSettings() : this.openSettings();
  }

  openSettings(): void {
    this.settingsOpen = true;
    this.mw.win.contentView.addChildView(this.settings);
    this.settings.setBounds(this.tabRegion());
    this.settings.setVisible(true);
    this.settings.webContents.focus();
  }

  closeSettings(): void {
    this.settingsOpen = false;
    this.settings.setVisible(false);
    this.chrome.webContents.focus();
  }

  focusOmnibox(): void {
    if (this.settingsOpen) this.closeSettings();
    this.chrome.webContents.send(Event.FocusOmnibox);
    this.chrome.webContents.focus();
  }

  /** Broadcast to every trusted UI view — used by core AND by plugins (sendToUi). */
  send(channel: string, payload?: unknown): void {
    const views = [this.chrome, this.settings, ...[...this.surfaces.values()].map((s) => s.view)];
    for (const v of views) {
      if (v && !v.webContents.isDestroyed()) v.webContents.send(channel, payload);
    }
  }

  // --- Layout --------------------------------------------------------------

  private makeView(htmlPath: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.mw.win.contentView.addChildView(view);
    void view.webContents.loadFile(htmlPath);
    return view;
  }

  private tabRegion() {
    const [w, h] = this.mw.win.getContentSize();
    return { x: 0, y: CHROME_H, width: w, height: Math.max(0, h - CHROME_H) };
  }

  private layout(): void {
    const [w] = this.mw.win.getContentSize();
    this.chrome.setBounds({ x: 0, y: 0, width: w, height: CHROME_H });
    this.tabs.layout();
    const r = this.tabRegion();
    if (this.settingsOpen) this.settings.setBounds(r);
    const active = this.surfaces.get(this.mode)?.view;
    if (active) active.setBounds(r);
  }
}
