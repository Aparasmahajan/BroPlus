import { BrowserWindow, nativeTheme } from 'electron';
import { Event } from '../shared/ipc-contract';

export const OPACITY_MIN = 0.2; // never let the user fade the window fully away
export const OPACITY_MAX = 1.0;
export const OPACITY_STEP = 0.05;
export const CHROME_H = 84; // height of the top chrome (tab strip + toolbar)

/**
 * Owns the single top-level BrowserWindow and its native capabilities:
 * screen-share invisibility (setContentProtection), opacity (setOpacity),
 * overlay mode, the boss key and full screen. The chrome UI, the tab views, the
 * overlays and every plugin panel are layered inside this one native window
 * (see browser.ts), so the flags cover everything on screen at once.
 *
 * Screen-share hiding and opacity are switched on/driven by their PLUGINS
 * (overlay-hiding, opacity). A build without them never turns them on, so the
 * window is an ordinary, solid, capturable browser.
 */
export class MainWindow {
  readonly win: BrowserWindow;
  /** Set by the Browser orchestrator to forward events to the UI views. */
  emit: (channel: string, payload: unknown) => void = () => {};

  private opacity = 1.0;
  private captureHidden = false; // the overlay-hiding plugin turns it on at boot
  private overlayMode = false;

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

  // --- Opacity -------------------------------------------------------------

  getOpacity(): number {
    return this.opacity;
  }

  setOpacity(value: number): void {
    const clamped = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, value));
    this.opacity = Math.round(clamped * 100) / 100;
    this.win.setOpacity(this.opacity);
    this.emit(Event.OpacityChanged, this.opacity);
  }

  nudgeOpacity(delta: number): void {
    this.setOpacity(this.opacity + delta);
  }

  // --- Screen-share invisibility ------------------------------------------

  getCaptureHidden(): boolean {
    return this.captureHidden;
  }

  setCaptureHidden(hidden: boolean): void {
    this.captureHidden = hidden;
    this.applyCaptureHidden();
    this.emit(Event.CaptureHiddenChanged, this.captureHidden);
  }

  toggleCaptureHidden(): void {
    this.setCaptureHidden(!this.captureHidden);
  }

  private applyCaptureHidden(): void {
    // One call, two OSes:
    //   Windows → SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
    //   macOS   → NSWindow.sharingType = NSWindowSharingNone
    this.win.setContentProtection(this.captureHidden);
  }

  // --- Overlay mode (click-through + float on top) ------------------------

  getOverlayMode(): boolean {
    return this.overlayMode;
  }

  /**
   * Overlay mode turns Bro into a passive floating pane: mouse events pass
   * through to whatever is beneath it, and it stays above other windows. Pair
   * it with low opacity + capture-hidden for a reference overlay no one else
   * sees. Toggle it back with the global hotkey (the UI is click-through while
   * it's on).
   */
  setOverlayMode(on: boolean): void {
    this.overlayMode = on;
    // forward:true still delivers mousemove to the renderer, so hover works.
    this.win.setIgnoreMouseEvents(on, { forward: true });
    this.win.setAlwaysOnTop(on, 'screen-saver');
    this.emit(Event.OverlayModeChanged, on);
  }

  toggleOverlayMode(): void {
    this.setOverlayMode(!this.overlayMode);
  }

  // --- Boss key + full screen ---------------------------------------------

  /** Hide Bro completely (no taskbar/dock entry), or bring it straight back. */
  toggleHidden(): void {
    if (this.win.isVisible()) {
      this.win.hide();
    } else {
      this.win.show();
      this.win.focus();
    }
  }

  toggleFullScreen(): void {
    this.win.setFullScreen(!this.win.isFullScreen());
  }
}
