// Shared plumbing for the e2e suites: DevTools connections, polling, PASS/FAIL output.
// Ports default to 9229 (main-process inspector) / 9333 (page DevTools); override with
// BRO_E2E_INSPECT_PORT / BRO_E2E_CDP_PORT (launch.mjs reads the same variables).
export const INSPECT_PORT = Number(process.env.BRO_E2E_INSPECT_PORT || 9229);
export const CDP_PORT = Number(process.env.BRO_E2E_CDP_PORT || 9333);
export const MAIN_URL = `http://127.0.0.1:${INSPECT_PORT}`;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy (that value) or `ms` runs out (false). Throws count as "not yet". */
export async function waitFor(fn, ms = 30000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(every);
  }
}

/** A DevTools websocket: `call` sends a raw method, `evaluate` runs an expression, `events` collects notifications. */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = {}; const events = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
    else if (d.method) events.push(d);
  };
  const call = (method, params = {}) => new Promise((res) => { pending[++id] = res; ws.send(JSON.stringify({ id, method, params })); });
  // includeCommandLineAPI: makes `require` reachable at the top level of a main-process expression.
  const evaluate = async (expression) => {
    const d = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? JSON.stringify(d.result.exceptionDetails));
    return d.result?.result?.value;
  };
  return { ws, call, evaluate, events };
}

/**
 * Connect to the Electron main process. `M(code)` runs `code` as the body of an async
 * function with `E` (electron), `fs`, `path` and `wait(ms)` in scope — `return` a value.
 */
export async function connectMain(ms = 120000) {
  let list;
  const ok = await waitFor(async () => (list = await (await fetch(`${MAIN_URL}/json/list`)).json()).length > 0, ms, 500);
  if (!ok) throw new Error(`no main-process inspector on ${MAIN_URL} (start the app with launch.mjs)`);
  const main = await connect(list[0].webSocketDebuggerUrl);
  const M = (code) => main.evaluate(`(globalThis.__E = globalThis.__E || require('electron'), globalThis.__fs = globalThis.__fs || require('fs'), globalThis.__path = globalThis.__path || require('path'), (async () => { const E = globalThis.__E, fs = globalThis.__fs, path = globalThis.__path; const wait = (ms) => new Promise(r => setTimeout(r, ms)); ${code} })())`);
  return { main, M };
}

/** Wait until the chrome page (dist/ui/index.html) has loaded; returns `C(js)` that evaluates in it via main. */
export async function chromeEval(M, ms = 120000) {
  const ok = await waitFor(() => M(`return E.webContents.getAllWebContents().some(w => w.getURL().endsWith('dist/ui/index.html') && !w.isLoading())`), ms, 500);
  if (!ok) throw new Error('chrome page never loaded');
  return (js) => M(`const c = E.webContents.getAllWebContents().find(w => w.getURL().endsWith('dist/ui/index.html')); return c.executeJavaScript(${JSON.stringify(js)})`);
}

/** All page targets on the page DevTools port. */
export const pageTargets = async () => (await (await fetch(`${CDP_URL}/json/list`)).json()).filter((t) => t.type === 'page');

/** Connect to the page whose URL ends with `name` (e.g. 'index.html') with Runtime events enabled. */
export async function page(name, ms = 60000) {
  const t = await waitFor(async () => (await pageTargets()).find((p) => p.url.endsWith(name)), ms, 500);
  if (!t) throw new Error('no page ' + name);
  const c = await connect(t.webSocketDebuggerUrl);
  await c.call('Runtime.enable');
  return c;
}

/** PASS/FAIL printer; `done()` prints the tally and exits non-zero on any failure. */
export function checker() {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); return !!ok; };
  const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
  return { check, done, get failed() { return fail; } };
}

/** Exceptions a page connection saw (Runtime.exceptionThrown events). */
export const exceptionsOf = (...conns) => conns.flatMap((c) => c.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description));
