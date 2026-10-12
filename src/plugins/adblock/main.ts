// adblock — CAPABILITY plugin (no surface). Ad/tracker blocking at the request
// layer is where "faster than Chrome" is won (ARCHITECTURE.md §4). Full engine
// (@ghostery/adblocker-electron attached to the shared session) lands in a later
// phase; this reserves the plugin slot so a build can already include/exclude it.
import type { BroPlugin, MainContext } from '../../core/plugin';

const plugin: BroPlugin = {
  manifest: {
    id: 'adblock',
    title: 'Ad / tracker blocking',
    description: 'Request-level ad & tracker blocking on the shared session (EasyList / uBO lists).',
  },

  registerMain(_ctx: MainContext): void {
    // Phase: attach @ghostery/adblocker-electron to _ctx.session here.
  },
};

export default plugin;
