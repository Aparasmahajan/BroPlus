// opacity — CAPABILITY plugin. Fades the whole window (UI + all tabs + panels)
// so it can sit as a ghost over other work. Excluded from a build → the window
// is always solid and the opacity slider/hotkeys are absent.
//
// Channels:
//   opacity:get     invoke → number (0.2..1)
//   opacity:set     send(number)
//   opacity:nudge   send(number delta)
//   opacity:changed event → number
// Hotkeys: Ctrl/Cmd+Shift+] more opaque, Ctrl/Cmd+Shift+[ more transparent.
import type { BroPlugin, MainContext } from '../../core/plugin';

const STEP = 0.05;

const plugin: BroPlugin = {
  manifest: {
    id: 'opacity',
    title: 'Window opacity',
    description: 'Fade the whole window from solid to a faint ghost. Floor is 20% so it can never be lost.',
  },

  registerMain(ctx: MainContext): void {
    const broadcast = () => ctx.sendToUi('opacity:changed', ctx.getOpacity());

    ctx.ipc.handle('opacity:get', () => ctx.getOpacity());
    ctx.ipc.on('opacity:set', (_e, v: number) => {
      ctx.setOpacity(v);
      broadcast();
    });
    ctx.ipc.on('opacity:nudge', (_e, d: number) => {
      ctx.nudgeOpacity(d);
      broadcast();
    });

    ctx.registerHotkey('CommandOrControl+Shift+]', () => {
      ctx.nudgeOpacity(STEP);
      broadcast();
    });
    ctx.registerHotkey('CommandOrControl+Shift+[', () => {
      ctx.nudgeOpacity(-STEP);
      broadcast();
    });
  },
};

export default plugin;
