import { BrowserWindow, nativeTheme } from 'electron';
import { Event } from '../shared/ipc-contract';

export const OPACITY_MIN = 0.2; // never let the user fade the window fully away
export const OPACITY_MAX = 1.0;
export const OPACITY_STEP = 0.05;
export const CHROME_H = 84; // height of the top chrome (tab strip + toolbar)

/**
 * Owns the single top-level BrowserWindow and exposes its native capabilities —
 * screen-share invisibility (setContentProtection) and opacity (setOpacity) — as
 * plain methods. It does NOT decide policy or emit feature events: the
 * overlay-hiding and opacity PLUGINS drive these and broadcast changes. If those
 * plugins are excluded from a build, nothing calls these and the window is an
 * ordinary, solid, capturable browser.
 *
 * The chrome UI, tab views and all plugin panels live inside this one native
 * window (see browser.ts), so both flags cover everything on screen at once.
 */
export class MainWindow {
  readonly win: BrowserWindow;
  /** Set by the Browser orchestrator to forward core events to the UI views. */
  emit: (channel: string, payload: unknown) => void = () => {};

  private opacity = 1.0;
  private captureHidden = false; // off until the overlay-hiding plugin turns it on

  constructor() {
    this.win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      show: false,
      frame: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1b1e' : '#ffffff',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 12 } : undefined,
    });

    this.win.on('maximize', () => this.emit(Event.MaximizedChanged, true));
    this.win.on('unmaximize', () => this.emit(Event.MaximizedChanged, false));
  }

  // --- Opacity capability --------------------------------------------------

  getOpacity(): number {
    return this.opacity;
  }

  setOpacity(value: number): void {
    const clamped = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, value));
    this.opacity = Math.round(clamped * 100) / 100;
    this.win.setOpacity(this.opacity);
  }

  nudgeOpacity(delta: number): void {
    this.setOpacity(this.opacity + delta);
  }

  // --- Screen-share invisibility capability --------------------------------

  getCaptureHidden(): boolean {
    return this.captureHidden;
  }

  setCaptureHidden(hidden: boolean): void {
    this.captureHidden = hidden;
    // One call, two OSes:
    //   Windows → SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
    //   macOS   → NSWindow.sharingType = NSWindowSharingNone
    this.win.setContentProtection(hidden);
  }
}
