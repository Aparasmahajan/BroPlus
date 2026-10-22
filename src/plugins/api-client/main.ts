// api-client — SURFACE plugin (Postman-class API client). Contributes the 'api'
// mode + panel. Everything that touches the network, files, secrets or scripts
// runs here in main; the panel is a thin UI over the generic plugin bus.
// Depends on `diff` for response compare.
//
// Channels (invoke unless noted):
//   api:state                       → ApiState
//   api:run {request, collectionId?, folderId?}        → RunResult (Send)
//   api:resolve {request, collectionId?, folderId?}    → HttpRequest (code snippets; no scripts, secrets unexpanded)
//   api:save-collection / api:delete-collection / api:save-environment /
//   api:delete-environment / api:set-active-env / api:save-globals
//   api:history / api:history-delete / api:history-clear
//   api:runner-start RunnerOptions  → runId   (progress: event api:run-progress)
//   api:runner-stop runId
//   api:oauth2-token {oauth2, collectionId?}           → { accessToken?, error? }
//   api:import-file / api:import-text {text}           → ImportSummary
//   api:export-collection id / api:export-environment id → saved path | null
//   api:pick-file {purpose}         → path | { path, rows } (data files)
//   api:save-response {b64, name}   → saved path | null
//   api:open-tab url                (send) — open in a browser tab
//   api:cookies-list {domain?} / api:cookie-delete / api:cookies-clear
//   api:vault-set {name, value} / api:vault-delete name
//   events: api:changed (a collection file changed on disk), api:run-progress
import { dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BroPlugin, MainContext } from '../../core/plugin';
import {
  findFolder,
  findRequest,
  normalizeRequest,
  type ApiState,
  type Collection,
  type Environment,
  type Folder,
  type KeyVal,
  type OAuth2,
  type RunnerOptions,
  type SavedRequest,
} from '../../shared/api-model';
import type { ProxyService } from '../../shared/services';
import { mergeScopes, scopeOf } from '../../shared/vars';
import { HttpEngine } from './engine';
import { importText, parseDataFile, toPostman, toPostmanEnv, type Imported } from './interop';
import { effectiveAuth, finalize, makeDraft } from './resolve';
import { ApiRunner } from './runner';
import { ApiStore } from './store';
import { Vault } from './vault';

export interface ImportSummary {
  collections: string[];
  environments: string[];
  /** A cURL import becomes an unsaved request the panel opens in a tab. */
  request?: SavedRequest;
  error?: string;
}

const plugin: BroPlugin = {
  manifest: {
    id: 'api-client',
    title: 'API client',
    description:
      'Postman-class API workbench: collections + folders, environments/globals/collection variables, auth (bearer, basic, API key, OAuth 2), every body type, pre-request & test scripts, collection runner, import/export (Postman, OpenAPI, cURL), code snippets, browser cookies, response diff.',
    dependsOn: ['diff'],
    surface: { mode: 'api', label: 'API', html: 'api-client.html' },
  },

  registerMain(ctx: MainContext): void {
    const engine = new HttpEngine();
    const store = new ApiStore(ctx.configDir);
    const vault = new Vault(ctx.configDir);
    const ready = store.init();
    store.onExternalChange = () => ctx.sendToUi('api:changed');
    ctx.app.on('will-quit', () => store.dispose());

    const runner = new ApiRunner({
      engine,
      store,
      vault,
      cookies: () => ctx.session,
      proxy: () => ctx.lookup<ProxyService>('proxy'),
      emit: (ch, p) => ctx.sendToUi(ch, p),
    });

    const handle = <A, R>(ch: string, fn: (arg: A) => Promise<R> | R) =>
      ctx.ipc.handle(ch, async (_e, arg: A) => {
        await ready;
        return fn(arg);
      });

    /** Where a (possibly unsaved) working copy belongs: its collection + folder chain. */
    const locate = async (req: SavedRequest, collectionId?: string, folderId?: string) => {
      const cols = await store.collections();
      const saved = req.id ? findRequest(cols, req.id) : null;
      if (saved) return { collection: saved.collection, folders: saved.folders };
      const collection = collectionId ? cols.find((c) => c.id === collectionId) : undefined;
      let folders: Folder[] = [];
      if (collection && folderId) {
        const hit = findFolder(collection, folderId);
        if (hit) folders = [...hit.chain, hit.folder];
      }
      return { collection, folders };
    };

    // --- State + send ---------------------------------------------------------
    handle('api:state', async (): Promise<ApiState> => {
      const proxy = ctx.lookup<ProxyService>('proxy');
      return {
        collections: await store.collections(),
        environments: await store.environments(),
        activeEnvId: store.activeEnv,
        globals: store.getGlobals(),
        vaultKeys: await vault.keys(),
        proxy: { available: !!proxy, running: !!proxy?.running },
      };
    });

    handle('api:run', async (p: { request: SavedRequest; collectionId?: string; folderId?: string }) => {
      const req = normalizeRequest(p.request, randomUUID);
      const loc = await locate(req, p.collectionId, p.folderId);
      return runner.runOne(req, loc, { envId: store.activeEnv, recordHistory: true });
    });

    handle('api:resolve', async (p: { request: SavedRequest; collectionId?: string; folderId?: string }) => {
      const req = normalizeRequest(p.request, randomUUID);
      const loc = await locate(req, p.collectionId, p.folderId);
      const env = await store.environment(store.activeEnv);
      const vars = mergeScopes(scopeOf(store.getGlobals()), scopeOf(loc.collection?.variables), scopeOf(env?.vars));
      const auth = effectiveAuth(req, loc.folders, loc.collection);
      const draft = makeDraft(req, auth);
      try {
        return await finalize(req, auth, draft, draft, vars);
      } catch (e) {
        return { method: req.method, url: req.url, headers: [], body: { kind: 'text', text: `(${(e as Error).message})` } };
      }
    });

    // --- Collections / environments / globals --------------------------------
    handle('api:save-collection', (c: Collection) => store.saveCollection(c));
    handle('api:delete-collection', (id: string) => store.deleteCollection(id));
    handle('api:save-environment', (env: Environment) => store.saveEnvironment(env));
    handle('api:delete-environment', (id: string) => store.deleteEnvironment(id));
    handle('api:set-active-env', (id: string | null) => store.setActiveEnv(id || null));
    handle('api:save-globals', (rows: KeyVal[]) => store.saveGlobals(Array.isArray(rows) ? rows : []));

    // --- History -------------------------------------------------------------
    handle('api:history', () => store.listHistory());
    handle('api:history-delete', (id: string) => store.deleteHistory(String(id)));
    handle('api:history-clear', () => store.clearHistory());

    // --- Runner --------------------------------------------------------------
    handle('api:runner-start', (o: RunnerOptions) => {
      const runId = runner.newRunId();
      void runner.runCollection(o, runId).catch((e) => console.error('[api] runner failed', e));
      return runId;
    });
    handle('api:runner-stop', (runId: string) => runner.stop(String(runId)));

    // --- OAuth 2 ---------------------------------------------------------------
    handle('api:oauth2-token', (p: { oauth2: OAuth2; collectionId?: string }) => runner.oauth2Token(p.oauth2, store.activeEnv, p.collectionId));

    // --- Import / export ---------------------------------------------------------
    const saveImported = async (items: Imported[]): Promise<ImportSummary> => {
      const out: ImportSummary = { collections: [], environments: [] };
      for (const it of items) {
        if (it.kind === 'collection') out.collections.push((await store.saveCollection(it.collection)).name);
        else if (it.kind === 'environment') out.environments.push((await store.saveEnvironment(it.environment)).name);
        else out.request = it.request;
      }
      return out;
    };
    handle('api:import-file', async () => {
      const r = await dialog.showOpenDialog(ctx.win, {
        title: 'Import into the API client',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Postman / OpenAPI / cURL', extensions: ['json', 'yaml', 'yml', 'txt', 'sh'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (r.canceled || !r.filePaths.length) return null;
      const items: Imported[] = [];
      const errors: string[] = [];
      for (const path of r.filePaths) {
        try {
          items.push(importText(await fs.readFile(path, 'utf8'), basename(path)));
        } catch (e) {
          errors.push(`${basename(path)}: ${(e as Error).message}`);
        }
      }
      const sum = await saveImported(items);
      if (errors.length) sum.error = errors.join('\n');
      return sum;
    });
    handle('api:import-text', async (p: { text: string }) => {
      try {
        return await saveImported([importText(String(p?.text ?? ''))]);
      } catch (e) {
        return { collections: [], environments: [], error: (e as Error).message } satisfies ImportSummary;
      }
    });
    const saveAs = async (title: string, name: string, data: string) => {
      const r = await dialog.showSaveDialog(ctx.win, { title, defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return null;
      await fs.writeFile(r.filePath, data, 'utf8');
      return r.filePath;
    };
    const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'export';
    handle('api:export-collection', async (id: string) => {
      const c = await store.collection(String(id));
      return c ? saveAs('Export collection (Postman v2.1)', `${fileSafe(c.name)}.postman_collection.json`, toPostman(c)) : null;
    });
    handle('api:export-environment', async (id: string) => {
      const e = await store.environment(String(id));
      return e ? saveAs('Export environment (Postman)', `${fileSafe(e.name)}.postman_environment.json`, toPostmanEnv(e)) : null;
    });

    // --- Files: bodies, data files, saving a response ------------------------------
    handle('api:pick-file', async (p: { purpose: 'binary' | 'multipart' | 'data' }) => {
      const data = p?.purpose === 'data';
      const r = await dialog.showOpenDialog(ctx.win, {
        title: data ? 'Runner data file (CSV or JSON)' : 'Choose a file to send',
        properties: ['openFile'],
        filters: data ? [{ name: 'CSV / JSON', extensions: ['csv', 'json'] }] : [{ name: 'All files', extensions: ['*'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      const path = r.filePaths[0];
      if (!data) return path;
      try {
        return { path, rows: parseDataFile(await fs.readFile(path, 'utf8'), path) };
      } catch (e) {
        return { path, rows: [], error: (e as Error).message };
      }
    });
    handle('api:save-response', async (p: { b64: string; name: string }) => {
      const r = await dialog.showSaveDialog(ctx.win, { title: 'Save response', defaultPath: fileSafe(p?.name || 'response') });
      if (r.canceled || !r.filePath) return null;
      await fs.writeFile(r.filePath, Buffer.from(String(p.b64 ?? ''), 'base64'));
      return r.filePath;
    });
    ctx.ipc.on('api:open-tab', (_e, url: string) => {
      if (/^https?:\/\//i.test(String(url))) ctx.openTab(String(url));
    });

    // --- Cookies (the browser's jar — shared with the tabs) ----------------------
    handle('api:cookies-list', async (p: { domain?: string }) => {
      const all = await ctx.session.cookies.get(p?.domain ? { domain: p.domain } : {});
      return all.map((c) => ({ name: c.name, value: c.value, domain: c.domain ?? '', path: c.path ?? '/', secure: !!c.secure, httpOnly: !!c.httpOnly, expires: c.expirationDate }));
    });
    handle('api:cookie-delete', async (c: { name: string; domain: string; path: string; secure: boolean }) => {
      const host = c.domain.replace(/^\./, '');
      await ctx.session.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, c.name);
    });
    handle('api:cookies-clear', async (domain: string) => {
      const list = await ctx.session.cookies.get({ domain: String(domain) });
      for (const c of list) {
        const host = (c.domain ?? '').replace(/^\./, '');
        await ctx.session.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, c.name);
      }
    });

    // --- Vault (names only ever leave main) -----------------------------------------
    handle('api:vault-set', async (p: { name: string; value: string }) => {
      const name = String(p?.name ?? '').trim();
      if (!/^[\w./-]+$/.test(name)) throw new Error('Secret names may use letters, digits and . _ / -');
      await vault.set(name, String(p.value ?? ''));
      return vault.keys();
    });
    handle('api:vault-delete', async (name: string) => {
      await vault.remove(String(name));
      return vault.keys();
    });
  },
};

export default plugin;
