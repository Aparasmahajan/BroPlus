// api-client — SURFACE plugin (Postman-class API client). Contributes the 'api'
// mode + panel, the HTTP send, and collection/environment/history persistence.
// Depends on `diff` for response compare.
import type { BroPlugin, MainContext } from '../../core/plugin';
import type { HttpRequest } from '../../shared/http-model';
import type { Collection, Environment } from '../../shared/api-model';
import { HttpEngine } from './engine';
import { ApiStore } from './store';

const plugin: BroPlugin = {
  manifest: {
    id: 'api-client',
    title: 'API client',
    description: 'Postman-class request builder: collections, environments, variables, response viewer with diff.',
    dependsOn: ['diff'],
    surface: { mode: 'api', label: 'API', html: 'api-client.html' },
  },

  registerMain(ctx: MainContext): void {
    const engine = new HttpEngine();
    const store = new ApiStore(ctx.configDir);
    void store.init();

    // Send (variables/auth/params/body already resolved by the UI) → record.
    ctx.ipc.handle('api:send', async (_e, req: HttpRequest) => {
      const ex = await engine.send(req);
      store.addHistory(ex);
      return ex;
    });

    // Collections / environments / history.
    ctx.ipc.handle('api:state', () => store.state());
    ctx.ipc.handle('api:save-collection', (_e, c: Collection) => store.saveCollection(c));
    ctx.ipc.handle('api:delete-collection', (_e, id: string) => store.deleteCollection(id));
    ctx.ipc.handle('api:save-environment', (_e, env: Environment) => store.saveEnvironment(env));
    ctx.ipc.handle('api:delete-environment', (_e, id: string) => store.deleteEnvironment(id));
    ctx.ipc.handle('api:set-active-env', (_e, id: string | null) => store.setActiveEnv(id));
    ctx.ipc.handle('api:history', () => store.listHistory());
    ctx.ipc.handle('api:history-clear', () => store.clearHistory());
  },
};

export default plugin;
