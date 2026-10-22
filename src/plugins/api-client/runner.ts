// ApiRunner — runs requests end to end, in main, the way Postman does:
//
//   pre-request scripts (collection → folders → request)
//     → resolve {{vars}} / auth / body           (resolve.ts)
//     → expand ${env:} / ${vault:} secrets       (never stored, never shown)
//     → send (cookies, redirects, TLS, proxy)    (engine.ts)
//     → test scripts (collection → folders → request)
//     → write changed variables back to disk     (store.ts)
//
// The same path serves the Send button and the collection runner, so a request
// behaves identically in both.
import { randomUUID } from 'node:crypto';
import type { Session } from 'electron';
import {
  DEFAULT_SETTINGS,
  findFolder,
  requestsInOrder,
  type Collection,
  type ConsoleLine,
  type Folder,
  type OAuth2,
  type RunResult,
  type RunnerOptions,
  type RunnerStep,
  type RunnerSummary,
  type SavedRequest,
  type TestResult,
} from '../../shared/api-model';
import type { Header, HttpRequest } from '../../shared/http-model';
import type { ProxyService } from '../../shared/services';
import { mergeScopes, scopeOf, substituteVars } from '../../shared/vars';
import type { HttpEngine } from './engine';
import { effectiveAuth, expandSecrets, finalize, makeDraft } from './resolve';
import { runScript, type VarMaps } from './sandbox';
import type { ApiStore } from './store';
import type { Vault } from './vault';

/** Bodies bigger than this reach test scripts truncated (scripts run in a small sandbox). */
const SCRIPT_BODY_MAX = 2 * 1024 * 1024;

export interface RunnerDeps {
  engine: HttpEngine;
  store: ApiStore;
  vault: Vault;
  cookies: () => Session;
  proxy: () => ProxyService | undefined;
  emit: (channel: string, payload: unknown) => void;
}

export interface RunOneOptions {
  envId: string | null;
  iteration?: number;
  iterationCount?: number;
  data?: Record<string, string>;
  /** Single sends go to History; runner steps don't (Postman's behaviour). */
  recordHistory: boolean;
}

export class ApiRunner {
  private stopped = new Set<string>();

  constructor(private d: RunnerDeps) {}

  async runOne(req: SavedRequest, loc: { collection?: Collection; folders: Folder[] }, o: RunOneOptions): Promise<RunResult> {
    const { store } = this.d;
    const col = loc.collection;
    const env = await store.environment(o.envId);
    let vars: VarMaps = {
      globals: scopeOf(store.getGlobals()),
      collection: scopeOf(col?.variables),
      environment: scopeOf(env?.vars),
      iteration: { ...(o.data ?? {}) },
      locals: {},
    };
    const before = JSON.stringify({ g: vars.globals, c: vars.collection, e: vars.environment });
    const tests: TestResult[] = [];
    const consoleLines: ConsoleLine[] = [];
    let nextRequest: string | null | undefined;
    const info = {
      requestName: req.name,
      requestId: req.id,
      iteration: o.iteration ?? 0,
      iterationCount: o.iterationCount ?? 1,
      eventName: 'prerequest',
    };
    const chain: { label: string; scripts?: { pre?: string; test?: string } }[] = [
      ...(col ? [{ label: `Collection “${col.name}”`, scripts: col.scripts }] : []),
      ...loc.folders.map((f) => ({ label: `Folder “${f.name}”`, scripts: f.scripts })),
      { label: `Request “${req.name}”`, scripts: req.scripts },
    ];

    const finish = async (r: Omit<RunResult, 'tests' | 'console' | 'varsChanged' | 'nextRequest'>): Promise<RunResult> => {
      const after = JSON.stringify({ g: vars.globals, c: vars.collection, e: vars.environment });
      const varsChanged = after !== before;
      if (varsChanged) {
        await store.writeBackVars({
          envId: env ? env.id : null,
          environment: env ? vars.environment : undefined,
          globals: vars.globals,
          collectionId: col?.id,
          collection: col ? vars.collection : undefined,
        });
      }
      return { ...r, tests, console: consoleLines, nextRequest, varsChanged };
    };

    // 1. Pre-request scripts on the draft.
    const auth = effectiveAuth(req, loc.folders, col);
    const original = makeDraft(req, auth);
    let draft = structuredClone(original);
    let skip = false;
    for (const s of chain) {
      if (!s.scripts?.pre?.trim()) continue;
      const out = await runScript({ event: 'prerequest', from: `${s.label} · pre-request`, code: s.scripts.pre, vars, info, request: draft });
      vars = out.vars;
      draft = out.request;
      tests.push(...out.tests);
      consoleLines.push(...out.console);
      if (out.nextRequest !== undefined) nextRequest = out.nextRequest;
      if (out.skipRequest) skip = true;
      if (out.error) return finish({ error: `Pre-request script (${s.label}): ${out.error}` });
    }
    if (skip) return finish({ error: 'Request skipped by pm.execution.skipRequest()' });

    // 2. Resolve + secrets.
    const merged = mergeScopes(vars.globals, vars.collection, vars.environment, vars.iteration, vars.locals);
    let resolved: HttpRequest;
    try {
      resolved = await finalize(req, auth, original, draft, merged);
    } catch (e) {
      return finish({ error: `Could not build the request: ${(e as Error).message}` });
    }
    if (!resolved.url) return finish({ error: 'Enter a URL' });
    try {
      new URL(resolved.url);
    } catch {
      return finish({ error: `Not a valid URL: ${resolved.url}` });
    }
    const { req: wire, missing } = await expandSecrets(resolved, this.d.vault);
    if (missing.length) return finish({ error: `Unknown secret${missing.length > 1 ? 's' : ''}: ${missing.map((m) => `\${${m}}`).join(', ')}` });

    // 3. Send.
    const st = { ...DEFAULT_SETTINGS, ...(req.settings ?? {}) };
    const proxy = st.viaProxy ? this.d.proxy() : undefined;
    if (st.viaProxy && !proxy?.running) {
      consoleLines.push({ level: 'warn', text: 'Send through proxy is on, but the Proxy is not running — sent directly.', from: 'Bro Plus' });
    }
    let result;
    try {
      result = await this.d.engine.send(wire, {
        timeoutMs: st.timeoutMs,
        followRedirects: st.followRedirects,
        maxRedirects: st.maxRedirects,
        verifyTls: st.verifyTls,
        cookies: st.useBrowserCookies ? this.d.cookies() : null,
        proxy,
      });
    } catch (e) {
      return finish({ error: sendError(e, st.timeoutMs) });
    }
    const ex = result.exchange;
    // Never keep expanded secrets in history: record the pre-expansion request,
    // plus the Cookie header the jar added (cookies are not secrets we expanded).
    if (wire !== resolved) {
      const cookie = ex.request.headers.filter(([k]) => k.toLowerCase() === 'cookie' && !resolved.headers.some(([rk]) => rk.toLowerCase() === 'cookie'));
      ex.request = { ...resolved, url: result.redirects.length ? ex.request.url : resolved.url, headers: [...resolved.headers, ...cookie] };
    }
    if (o.recordHistory) {
      ex.meta.notes = [ex.meta.notes, req.name && req.name !== 'Untitled' ? req.name : ''].filter(Boolean).join(' · ') || undefined;
      store.addHistory(ex);
    }

    // 4. Test scripts.
    const r = ex.response!;
    const bodyText = Buffer.from(r.body.b64, 'base64').subarray(0, SCRIPT_BODY_MAX).toString('utf8');
    const response = {
      code: r.status,
      status: r.statusText,
      headers: r.headers,
      body: bodyText,
      responseTime: r.timingMs,
      responseSize: Buffer.byteLength(r.body.b64, 'base64') + (r.body.truncatedBytes ?? 0),
    };
    const sentView = { method: ex.request.method, url: ex.request.url, headers: ex.request.headers, body: ex.request.body?.text ?? '' };
    for (const s of chain) {
      if (!s.scripts?.test?.trim()) continue;
      const out = await runScript({
        event: 'test',
        from: `${s.label} · tests`,
        code: s.scripts.test,
        vars,
        info: { ...info, eventName: 'test' },
        request: sentView,
        response,
      });
      vars = out.vars;
      tests.push(...out.tests);
      consoleLines.push(...out.console);
      if (out.nextRequest !== undefined) nextRequest = out.nextRequest;
      if (out.error) {
        tests.push({ name: `${s.label}: script error`, passed: false, error: out.error });
      }
    }
    return finish({ exchange: ex, redirects: result.redirects });
  }

  // --- Collection runner ------------------------------------------------------

  async runCollection(o: RunnerOptions, runId: string): Promise<RunnerSummary> {
    const started = Date.now();
    const summary: RunnerSummary = { runId, done: false, steps: [], passed: 0, failed: 0, errors: 0, durationMs: 0 };
    const emit = () => {
      summary.durationMs = Date.now() - started;
      this.d.emit('api:run-progress', summary);
    };
    const col = await this.d.store.collection(o.collectionId);
    if (!col) {
      summary.done = true;
      emit();
      return summary;
    }
    const folder = o.folderId ? findFolder(col, o.folderId)?.folder : undefined;
    const list = requestsInOrder(col, folder);
    const rows = o.data?.length ? o.data : undefined;
    const iterations = rows ? rows.length : Math.max(1, Math.min(1000, Math.round(o.iterations || 1)));
    const maxSteps = list.length * iterations * 20 + 50; // setNextRequest loops can't run forever
    let steps = 0;

    outer: for (let it = 0; it < iterations; it++) {
      let idx = 0;
      while (idx < list.length) {
        if (this.stopped.has(runId) || ++steps > maxSteps) {
          summary.stopped = true;
          break outer;
        }
        const { request, folders } = list[idx];
        const res = await this.runOne(request, { collection: col, folders }, {
          envId: this.d.store.activeEnv,
          iteration: it,
          iterationCount: iterations,
          data: rows?.[it],
          recordHistory: false,
        });
        const step: RunnerStep = {
          iteration: it,
          requestId: request.id,
          name: request.name,
          method: res.exchange?.request.method ?? request.method,
          url: res.exchange?.request.url ?? substituteVars(request.url, {}),
          status: res.exchange?.response?.status,
          timingMs: res.exchange?.response?.timingMs,
          tests: res.tests,
          error: res.error,
        };
        summary.steps.push(step);
        for (const t of res.tests) t.passed ? summary.passed++ : summary.failed++;
        if (res.error) summary.errors++;
        emit();
        if (o.stopOnFailure && (res.error || res.tests.some((t) => !t.passed))) {
          summary.stopped = true;
          break outer;
        }
        if (res.nextRequest === null) break outer; // pm.execution.setNextRequest(null) ends the run
        if (typeof res.nextRequest === 'string') {
          const target = list.findIndex((x) => x.request.name === res.nextRequest || x.request.id === res.nextRequest);
          idx = target >= 0 ? target : list.length;
        } else {
          idx++;
        }
        if (o.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(o.delayMs, 60_000)));
      }
    }
    this.stopped.delete(runId);
    summary.done = true;
    emit();
    return summary;
  }

  stop(runId: string): void {
    this.stopped.add(runId);
  }

  // --- OAuth 2.0 ------------------------------------------------------------------

  /** "Get new access token": client-credentials or password grant against the token URL. */
  async oauth2Token(o: OAuth2, envId: string | null, collectionId?: string): Promise<{ accessToken?: string; error?: string; raw?: string }> {
    const store = this.d.store;
    const env = await store.environment(envId);
    const col = collectionId ? await store.collection(collectionId) : undefined;
    const vars = mergeScopes(scopeOf(store.getGlobals()), scopeOf(col?.variables), scopeOf(env?.vars));
    const sub = (s: string) => substituteVars(s ?? '', vars);
    const form = new URLSearchParams({ grant_type: o.grant });
    if (o.scope) form.set('scope', sub(o.scope));
    if (o.grant === 'password') {
      form.set('username', sub(o.username));
      form.set('password', sub(o.password));
    }
    const headers: Header[] = [
      ['Content-Type', 'application/x-www-form-urlencoded'],
      ['Accept', 'application/json'],
    ];
    if (o.clientAuth === 'body') {
      form.set('client_id', sub(o.clientId));
      if (o.clientSecret) form.set('client_secret', sub(o.clientSecret));
    } else {
      headers.push(['Authorization', `Basic ${Buffer.from(`${encodeURIComponent(sub(o.clientId))}:${encodeURIComponent(sub(o.clientSecret))}`).toString('base64')}`]);
    }
    const { req, missing } = await expandSecrets({ method: 'POST', url: sub(o.tokenUrl), headers, body: { kind: 'form', text: form.toString() } }, this.d.vault);
    if (missing.length) return { error: `Unknown secret: ${missing.join(', ')}` };
    try {
      const { exchange } = await this.d.engine.send(req, { ...DEFAULT_SETTINGS, cookies: null, maxRedirects: 5 });
      const raw = Buffer.from(exchange.response!.body.b64, 'base64').toString('utf8');
      let json: { access_token?: string; error?: string; error_description?: string } = {};
      try {
        json = JSON.parse(raw);
      } catch {
        /* not JSON */
      }
      if (json.access_token) return { accessToken: json.access_token, raw };
      return { error: json.error_description || json.error || `Token request failed (HTTP ${exchange.response!.status})`, raw };
    } catch (e) {
      return { error: sendError(e, DEFAULT_SETTINGS.timeoutMs) };
    }
  }

  newRunId(): string {
    return randomUUID();
  }
}

function sendError(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `Timed out after ${timeoutMs} ms`;
  const code = err?.cause?.code ?? err?.code;
  const msg = err?.cause?.message ?? err?.message ?? String(e);
  const hints: Record<string, string> = {
    ENOTFOUND: 'host not found (check the URL / your network)',
    ECONNREFUSED: 'connection refused (is the server running?)',
    ECONNRESET: 'connection reset by the server',
    CERT_HAS_EXPIRED: 'the server certificate has expired — turn off SSL verification in Settings to send anyway',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate — turn off SSL verification in Settings to send anyway',
    SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in the chain (corporate TLS inspection?) — turn off SSL verification in Settings to send anyway',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate could not be verified — turn off SSL verification in Settings to send anyway',
  };
  return code && hints[code] ? `${code}: ${hints[code]}` : `Could not send: ${msg}`;
}
