// adblock — CAPABILITY plugin (no surface). Request-level ad & tracker blocking
// with the Ghostery engine (EasyList + uBlock Origin lists, cached to disk) on
// EVERY session tabs use — default, each profile's and the private one — plus
// the YouTube ad shield (./preload.ts, a session frame preload). Excluding it
// from a build removes the engine, the shield, the toolbar counter and its
// Settings section.
//
// Channels (via the generic bus):
//   adblock:get     invoke → AdblockStats
//   adblock:set     send(boolean)   — on/off (persisted)
//   adblock:reload  send()          — re-download the filter lists
//   adblock:stats   event → AdblockStats
import type { BroPlugin, MainContext } from '../../core/plugin';
import { JsonStore } from '../../main/store';
import { AdBlock } from './engine';

const plugin: BroPlugin = {
  manifest: {
    id: 'adblock',
    title: 'Ad / tracker blocking',
    description: 'Request-level ad & tracker blocking on every browsing session (EasyList / uBO lists) + YouTube ad shield.',
  },

  registerMain(ctx: MainContext): void {
    const cfg = new JsonStore<{ enabled: boolean }>('adblock', { enabled: true });
    const adblock = new AdBlock((ch, p) => ctx.sendToUi(ch, p), cfg.get().enabled !== false);

    ctx.onSession((s) => adblock.addSession(s));
    // Filter lists load in the background once the window is up (only once,
    // even if macOS re-creates the window).
    let started = false;
    ctx.onStarted(() => {
      if (started) return;
      started = true;
      void adblock.init();
    });

    ctx.ipc.handle('adblock:get', () => adblock.getStats());
    ctx.ipc.on('adblock:set', (_e, enabled: boolean) => {
      cfg.set({ enabled: !!enabled });
      adblock.setEnabled(!!enabled);
    });
    ctx.ipc.on('adblock:reload', () => void adblock.reload());
    ctx.app.on('will-quit', () => cfg.flush());
  },
};

export default plugin;
