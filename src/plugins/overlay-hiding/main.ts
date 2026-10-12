// overlay-hiding — CAPABILITY plugin (the "invisible to screen share" feature).
//
// Drives the core window's content-protection via MainContext. If this plugin
// is excluded from a build, nothing ever calls setContentProtection, so the
// window is a perfectly ordinary, capturable browser — the feature is gone.
//
// Channels (via the generic bus):
//   overlay:get     invoke → boolean (currently hidden?)
//   overlay:set     send(boolean)
//   overlay:changed event → boolean   (so the Settings section stays in sync)
// Hotkey: Ctrl/Cmd+Shift+H toggles.
import type { BroPlugin, MainContext } from '../../core/plugin';

const plugin: BroPlugin = {
  manifest: {
    id: 'overlay-hiding',
    title: 'Hidden from screen share',
    description:
      'Excludes the window from software screen capture (WDA_EXCLUDEFROMCAPTURE on Windows / NSWindowSharingNone on macOS). Not DRM: a camera still sees the screen.',
  },

  registerMain(ctx: MainContext): void {
    // Default ON when this plugin ships — the whole point of Bro_plus.
    ctx.setCaptureHidden(true);

    const apply = (hidden: boolean) => {
      ctx.setCaptureHidden(hidden);
      ctx.sendToUi('overlay:changed', hidden);
    };

    ctx.ipc.handle('overlay:get', () => ctx.getCaptureHidden());
    ctx.ipc.on('overlay:set', (_e, hidden: boolean) => apply(hidden));
    ctx.registerHotkey('CommandOrControl+Shift+H', () => apply(!ctx.getCaptureHidden()));
  },
};

export default plugin;
