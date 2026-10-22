// overlay-hiding — CAPABILITY plugin (the "invisible to screen share" feature).
//
// Drives the core window's content-protection via MainContext. If this plugin
// is excluded from a build, nothing ever calls setContentProtection, so the
// window is a perfectly ordinary, capturable browser — the feature is gone.
//
// Channels (via the generic bus):
//   overlay:get     invoke → boolean (currently hidden?)
//   overlay:set     send(boolean)
//   overlay:changed event → boolean  (emitted by the window on every change, so
//                   the Settings section stays in sync with the hotkey too)
// Hotkey: the rebindable `stealth.toggleCapture` command (default
// Ctrl/Cmd+Shift+H, Settings → Keyboard shortcuts) — it exists only in builds
// that include this plugin (see shared/shortcuts.ts).
import type { BroPlugin, MainContext } from '../../core/plugin';

const plugin: BroPlugin = {
  manifest: {
    id: 'overlay-hiding',
    title: 'Hidden from screen share',
    description:
      'Excludes the window from software screen capture (WDA_EXCLUDEFROMCAPTURE on Windows / NSWindowSharingNone on macOS). Not DRM: a camera still sees the screen.',
  },

  registerMain(ctx: MainContext): void {
    // Default ON when this plugin ships — the whole point of Bro_plus. Applied
    // before the window is first shown, so not one frame is capturable.
    ctx.onWindow(() => ctx.setCaptureHidden(true));

    ctx.ipc.handle('overlay:get', () => ctx.getCaptureHidden());
    ctx.ipc.on('overlay:set', (_e, hidden: boolean) => ctx.setCaptureHidden(!!hidden));
  },
};

export default plugin;
