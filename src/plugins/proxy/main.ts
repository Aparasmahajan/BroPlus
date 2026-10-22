// proxy — SURFACE plugin (Burp-class intercepting proxy). Contributes the
// 'proxy' mode + panel and wires the mockttp engine's IPC. Depends on `diff`.
import type { BroPlugin, MainContext } from '../../core/plugin';
import type { HttpRequest } from '../../shared/http-model';
import type { ProxyService } from '../../shared/services';
import { ProxyEngine } from './engine';

const plugin: BroPlugin = {
  manifest: {
    id: 'proxy',
    title: 'Intercepting proxy',
    description:
      'Burp-class HTTPS intercept: live modify, HTTP history, Repeater, scope. Decrypts YOUR OWN / authorized traffic only.',
    dependsOn: ['diff'],
    surface: { mode: 'proxy', label: 'Proxy', html: 'proxy.html' },
  },

  registerMain(ctx: MainContext): void {
    const engine = new ProxyEngine(ctx.session, ctx.configDir);
    engine.onExchange = (ex) => ctx.sendToUi('proxy:exchange', ex);
    engine.onPaused = (p) => ctx.sendToUi('proxy:paused', p);
    // Other plugins (the API client's "send through proxy") find the live proxy here.
    ctx.provide<ProxyService>('proxy', {
      get running() {
        return engine.running;
      },
      get port() {
        return engine.port;
      },
      caPem: () => engine.caCertPem(),
    });

    ctx.ipc.handle('proxy:status', () => ({
      running: engine.running,
      port: engine.port,
      intercept: engine.intercept,
      scope: engine.scope,
    }));
    ctx.ipc.handle('proxy:start', async () => {
      await engine.start();
      return { running: engine.running, port: engine.port };
    });
    ctx.ipc.handle('proxy:stop', async () => {
      await engine.stop();
      return { running: engine.running };
    });
    ctx.ipc.on('proxy:intercept-set', (_e, on: boolean) => {
      engine.intercept = on;
    });
    ctx.ipc.on('proxy:scope-set', (_e, scope: string[]) => {
      engine.scope = Array.isArray(scope) ? scope : [];
    });
    ctx.ipc.on('proxy:forward', (_e, p: { holdId: string; request?: HttpRequest }) =>
      engine.resolveHold(p.holdId, true, p.request),
    );
    ctx.ipc.on('proxy:drop', (_e, holdId: string) => engine.resolveHold(holdId, false));
    ctx.ipc.handle('proxy:history', () => engine.list());
    ctx.ipc.on('proxy:clear', () => engine.clear());
    ctx.ipc.handle('proxy:repeater', (_e, req: HttpRequest) => engine.repeater(req));
    ctx.ipc.handle('proxy:ca', () => engine.caCertPem());
  },
};

export default plugin;
