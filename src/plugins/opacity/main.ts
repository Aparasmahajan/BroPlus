// opacity — CAPABILITY plugin. Fades the whole window (UI + all tabs + panels)
// so it can sit as a ghost over other work. Excluded from a build → the window
// is always solid and the opacity slider/hotkeys are absent.
//
// Channels:
//   opacity:get     invoke → number (0.2..1)
//   opacity:set     send(number)
//   opacity:nudge   send(number delta)
//   opacity:changed event → number (emitted by the window on every change)
// Hotkeys: the rebindable `stealth.opacityUp/Down/Reset` commands (defaults
// Ctrl/Cmd+Shift+] / [ / \) — they exist only in builds with this plugin.
import type { BroPlugin, MainContext } from '../../core/plugin';

const plugin: BroPlugin = {
  manifest: {
    id: 'opacity',
    title: 'Window opacity',
    description: 'Fade the whole window from solid to a faint ghost. Floor is 20% so it can never be lost.',
  },

  registerMain(ctx: MainContext): void {
    ctx.ipc.handle('opacity:get', () => ctx.getOpacity());
    ctx.ipc.on('opacity:set', (_e, v: number) => {
      if (Number.isFinite(v)) ctx.setOpacity(v);
    });
    ctx.ipc.on('opacity:nudge', (_e, d: number) => {
      if (Number.isFinite(d)) ctx.nudgeOpacity(d);
    });
  },
};

export default plugin;
