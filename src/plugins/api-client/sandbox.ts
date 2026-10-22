// Pre-request / test scripts, Postman-style (`pm.*`), run in a QuickJS
// interpreter compiled to WebAssembly (ARCHITECTURE.md §5.4: "treat script code
// as untrusted").
//
// Why QuickJS and not Node's `vm`: `vm` is not a security boundary — a script
// can climb out to `process` and own the machine. QuickJS is a separate JS
// engine inside a wasm sandbox: no require, no process, no fs, no network, no
// host objects at all. Data goes IN as a JSON literal and comes OUT as a JSON
// string; nothing else crosses. Each script gets a fresh runtime with a memory
// cap and a deadline, so `while(true){}` or a memory bomb just fails that script.
//
// Supported: pm.test, pm.expect (chai-style chains), pm.response (code, status,
// headers, json(), text(), responseTime, to.have.status/header/body, to.be.ok…),
// pm.request (url, method, headers.add/upsert/remove, body.raw), pm.environment /
// pm.globals / pm.collectionVariables / pm.variables / pm.iterationData,
// pm.info, pm.execution.setNextRequest / skipRequest (+ legacy
// postman.setNextRequest), console.*, atob/btoa. Not supported (no host access
// by design): pm.sendRequest, require(), CryptoJS.
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from 'quickjs-emscripten';
import type { ConsoleLine, TestResult } from '../../shared/api-model';
import type { Header } from '../../shared/http-model';

const DEADLINE_MS = 3_000;
const MEMORY_BYTES = 64 * 1024 * 1024;

export type VarMaps = {
  globals: Record<string, string>;
  collection: Record<string, string>;
  environment: Record<string, string>;
  iteration: Record<string, string>;
  locals: Record<string, string>;
};

export interface ScriptInput {
  event: 'prerequest' | 'test';
  /** Label for console lines / errors ("Collection", "Folder Auth", "Request"…). */
  from: string;
  code: string;
  vars: VarMaps;
  info: { requestName: string; requestId: string; iteration: number; iterationCount: number; eventName: string };
  request: { method: string; url: string; headers: Header[]; body: string };
  response?: { code: number; status: string; headers: Header[]; body: string; responseTime: number; responseSize: number };
}

export interface ScriptOutput {
  vars: VarMaps;
  request: { method: string; url: string; headers: Header[]; body: string };
  tests: TestResult[];
  console: ConsoleLine[];
  error?: string;
  nextRequest?: string | null;
  skipRequest: boolean;
}

let qjs: Promise<QuickJSWASMModule> | null = null;

export async function runScript(input: ScriptInput): Promise<ScriptOutput> {
  const fallback: ScriptOutput = {
    vars: input.vars,
    request: input.request,
    tests: [],
    console: [],
    skipRequest: false,
  };
  if (!input.code.trim()) return fallback;

  qjs ??= getQuickJS();
  const QuickJS = await qjs;
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(MEMORY_BYTES);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DEADLINE_MS));
  const vm = rt.newContext();
  try {
    // JSON is a valid JS literal, so the input can't break out of this expression.
    const src = `const __IN = ${JSON.stringify(input)};\n${PRELUDE}\n;(function () {\n${input.code}\n}).call(undefined);`;
    const run = vm.evalCode(src, `${input.from}.js`);
    let error: string | undefined;
    if (run.error) {
      error = String(errText(vm.dump(run.error)));
      run.error.dispose();
    } else {
      run.value.dispose();
      // Let promise-based tests settle.
      const jobs = rt.executePendingJobs();
      if (jobs.error) {
        error = String(errText(vm.dump(jobs.error)));
        jobs.error.dispose();
      }
    }
    const outRes = vm.evalCode('__OUT()');
    if (outRes.error) {
      outRes.error.dispose();
      return { ...fallback, error: error ?? 'Script state could not be read back' };
    }
    const raw = vm.getString(outRes.value);
    outRes.value.dispose();
    const out = JSON.parse(raw) as ScriptOutput;
    if (error) {
      const timedOut = /interrupted/i.test(error);
      out.error = timedOut ? `Script stopped: it ran longer than ${DEADLINE_MS / 1000} s` : error;
    }
    for (const c of out.console) c.from = input.from;
    return out;
  } catch (e) {
    return { ...fallback, error: e instanceof Error ? e.message : String(e) };
  } finally {
    vm.dispose();
    rt.dispose();
  }
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { name?: string; message?: string };
    return `${o.name ?? 'Error'}: ${o.message ?? JSON.stringify(e)}`;
  }
  return String(e);
}

/**
 * The `pm` object, written in plain JS that runs INSIDE QuickJS. Reads __IN,
 * mutates local copies, and __OUT() serialises the result.
 */
const PRELUDE = String.raw`
const __vars = JSON.parse(JSON.stringify(__IN.vars));
const __req = JSON.parse(JSON.stringify(__IN.request));
const __tests = [];
const __console = [];
let __next; let __skip = false;
const __str = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch (e) { return String(v); } };

const console = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => { if (__console.length < 500) __console.push({ level: level === 'debug' ? 'log' : level, text: args.map(__str).join(' '), from: '' }); };
}

// --- base64 (QuickJS has no atob/btoa) ---
const __B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function btoa(s) { s = String(s); let o = ''; for (let i = 0; i < s.length; i += 3) { const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2); const n = (a << 16) | ((b || 0) << 8) | (c || 0); o += __B64[(n >> 18) & 63] + __B64[(n >> 12) & 63] + (isNaN(b) ? '=' : __B64[(n >> 6) & 63]) + (isNaN(c) ? '=' : __B64[n & 63]); } return o; }
function atob(s) { s = String(s).replace(/=+$/, ''); let o = ''; let buf = 0, bits = 0; for (const ch of s) { const v = __B64.indexOf(ch); if (v < 0) continue; buf = (buf << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; o += String.fromCharCode((buf >> bits) & 255); } } return o; }

// --- deep equality + assertion chains (chai subset) ---
function __eq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => __eq(a[k], b[k]));
}
function __type(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
function AssertionError(message) { const e = new Error(message); e.name = 'AssertionError'; return e; }

function expect(actual, label) {
  const s = { neg: false, deep: false };
  const c = {};
  const show = (v) => __str(v);
  const check = (ok, msg, negMsg) => { if (ok === s.neg) throw AssertionError((label ? label + ': ' : '') + (s.neg ? negMsg : msg)); return c; };
  for (const w of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'but', 'own']) Object.defineProperty(c, w, { get: () => c });
  Object.defineProperty(c, 'not', { get: () => { s.neg = !s.neg; return c; } });
  Object.defineProperty(c, 'deep', { get: () => { s.deep = true; return c; } });
  const flag = (name, fn, msg, negMsg) => Object.defineProperty(c, name, { get: () => check(fn(), msg, negMsg) });
  flag('ok', () => !!actual, 'expected ' + show(actual) + ' to be truthy', 'expected ' + show(actual) + ' to be falsy');
  flag('true', () => actual === true, 'expected ' + show(actual) + ' to be true', 'expected value not to be true');
  flag('false', () => actual === false, 'expected ' + show(actual) + ' to be false', 'expected value not to be false');
  flag('null', () => actual === null, 'expected ' + show(actual) + ' to be null', 'expected value not to be null');
  flag('undefined', () => actual === undefined, 'expected ' + show(actual) + ' to be undefined', 'expected value not to be undefined');
  flag('NaN', () => Number.isNaN(actual), 'expected ' + show(actual) + ' to be NaN', 'expected value not to be NaN');
  flag('exist', () => actual !== null && actual !== undefined, 'expected value to exist', 'expected ' + show(actual) + ' not to exist');
  flag('empty', () => (typeof actual === 'string' || Array.isArray(actual)) ? actual.length === 0 : (actual && typeof actual === 'object') ? Object.keys(actual).length === 0 : false, 'expected ' + show(actual) + ' to be empty', 'expected ' + show(actual) + ' not to be empty');
  const eq = (v) => check(s.deep ? __eq(actual, v) : actual === v, 'expected ' + show(actual) + ' to equal ' + show(v), 'expected ' + show(actual) + ' not to equal ' + show(v));
  c.equal = c.equals = c.eq = eq;
  c.eql = c.eqls = (v) => check(__eq(actual, v), 'expected ' + show(actual) + ' to deeply equal ' + show(v), 'expected ' + show(actual) + ' not to deeply equal ' + show(v));
  c.above = c.gt = c.greaterThan = (n) => check(actual > n, 'expected ' + show(actual) + ' to be above ' + n, 'expected ' + show(actual) + ' to be at most ' + n);
  c.below = c.lt = c.lessThan = (n) => check(actual < n, 'expected ' + show(actual) + ' to be below ' + n, 'expected ' + show(actual) + ' to be at least ' + n);
  c.least = c.gte = (n) => check(actual >= n, 'expected ' + show(actual) + ' to be at least ' + n, 'expected ' + show(actual) + ' to be below ' + n);
  c.most = c.lte = (n) => check(actual <= n, 'expected ' + show(actual) + ' to be at most ' + n, 'expected ' + show(actual) + ' to be above ' + n);
  c.within = (a, b) => check(actual >= a && actual <= b, 'expected ' + show(actual) + ' to be within ' + a + '..' + b, 'expected ' + show(actual) + ' not to be within ' + a + '..' + b);
  c.a = c.an = (t) => check(__type(actual) === String(t).toLowerCase(), 'expected ' + show(actual) + ' to be a ' + t, 'expected ' + show(actual) + ' not to be a ' + t);
  c.instanceOf = c.instanceof = (k) => check(actual instanceof k, 'expected value to be an instance', 'expected value not to be an instance');
  c.include = c.includes = c.contain = c.contains = (v) => {
    let ok;
    if (typeof actual === 'string') ok = actual.indexOf(v) !== -1;
    else if (Array.isArray(actual)) ok = actual.some((x) => (s.deep ? __eq(x, v) : x === v));
    else if (actual && typeof actual === 'object' && v && typeof v === 'object') ok = Object.keys(v).every((k) => __eq(actual[k], v[k]));
    else ok = false;
    return check(ok, 'expected ' + show(actual) + ' to include ' + show(v), 'expected ' + show(actual) + ' not to include ' + show(v));
  };
  c.property = (name, ...val) => {
    const has = actual !== null && actual !== undefined && Object.prototype.hasOwnProperty.call(Object(actual), name);
    if (!val.length) return check(has, 'expected ' + show(actual) + ' to have property ' + name, 'expected ' + show(actual) + ' not to have property ' + name);
    return check(has && __eq(actual[name], val[0]), 'expected property ' + name + ' to be ' + show(val[0]) + ' but got ' + show(actual && actual[name]), 'expected property ' + name + ' not to be ' + show(val[0]));
  };
  c.lengthOf = c.length = (n) => check(actual != null && actual.length === n, 'expected length ' + n + ' but got ' + (actual == null ? actual : actual.length), 'expected length not to be ' + n);
  c.match = c.matches = (re) => check(re.test(String(actual)), 'expected ' + show(actual) + ' to match ' + re, 'expected ' + show(actual) + ' not to match ' + re);
  c.oneOf = (list) => check(list.some((x) => __eq(x, actual)), 'expected ' + show(actual) + ' to be one of ' + show(list), 'expected ' + show(actual) + ' not to be one of ' + show(list));
  c.keys = c.key = (...ks) => { const want = ks.length === 1 && Array.isArray(ks[0]) ? ks[0] : ks; const have = Object.keys(actual || {}); return check(want.every((k) => have.indexOf(k) !== -1), 'expected ' + show(actual) + ' to have keys ' + show(want), 'expected ' + show(actual) + ' not to have keys ' + show(want)); };
  c.status = (code) => check(actual && actual.code === code, 'expected status ' + code + ' but got ' + (actual && actual.code), 'expected status not to be ' + code);
  return c;
}
expect.fail = (msg) => { throw AssertionError(msg || 'expect.fail()'); };

// --- variable scopes ---
function __scope(map, writable) {
  const api = {
    get: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined),
    has: (k) => Object.prototype.hasOwnProperty.call(map, k),
    toObject: () => Object.assign({}, map),
    replaceIn: (str) => String(str).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (w, n) => (Object.prototype.hasOwnProperty.call(map, n) ? map[n] : w)),
  };
  if (writable) {
    api.set = (k, v) => { map[String(k)] = v === undefined || v === null ? '' : (typeof v === 'string' ? v : __str(v)); };
    api.unset = (k) => { delete map[k]; };
    api.clear = () => { for (const k of Object.keys(map)) delete map[k]; };
  }
  return api;
}
function __merged() { return Object.assign({}, __vars.globals, __vars.collection, __vars.environment, __vars.iteration, __vars.locals); }

// --- headers helper ---
function __headers(list, writable) {
  const find = (k) => list.findIndex((h) => h[0].toLowerCase() === String(k).toLowerCase());
  const api = {
    get: (k) => { const i = find(k); return i < 0 ? undefined : list[i][1]; },
    has: (k, v) => { const i = find(k); return i >= 0 && (v === undefined || list[i][1] === v); },
    toObject: () => { const o = {}; for (const [k, v] of list) o[k] = v; return o; },
    all: () => list.map(([key, value]) => ({ key, value })),
    each: (fn) => list.forEach(([key, value]) => fn({ key, value })),
    count: () => list.length,
  };
  if (writable) {
    const kv = (h, v) => (typeof h === 'string' ? [h, String(v ?? '')] : [String(h.key), String(h.value ?? '')]);
    api.add = (h, v) => { list.push(kv(h, v)); };
    api.upsert = (h, v) => { const p = kv(h, v); const i = find(p[0]); if (i >= 0) list[i] = p; else list.push(p); };
    api.remove = (k) => { for (let i = list.length - 1; i >= 0; i--) if (list[i][0].toLowerCase() === String(k).toLowerCase()) list.splice(i, 1); };
  }
  return api;
}

const pm = {
  info: __IN.info,
  environment: __scope(__vars.environment, true),
  globals: __scope(__vars.globals, true),
  collectionVariables: __scope(__vars.collection, true),
  iterationData: __scope(__vars.iteration, false),
  variables: {
    get: (k) => __merged()[k],
    has: (k) => Object.prototype.hasOwnProperty.call(__merged(), k),
    set: (k, v) => { __vars.locals[String(k)] = typeof v === 'string' ? v : __str(v); },
    unset: (k) => { delete __vars.locals[k]; },
    toObject: () => __merged(),
    replaceIn: (str) => { const m = __merged(); return String(str).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (w, n) => (Object.prototype.hasOwnProperty.call(m, n) ? m[n] : w)); },
  },
  request: {
    get url() { return __req.url; },
    set url(v) { __req.url = String(v); },
    get method() { return __req.method; },
    set method(v) { __req.method = String(v).toUpperCase(); },
    headers: __headers(__req.headers, __IN.event === 'prerequest'),
    body: {
      get raw() { return __req.body; },
      set raw(v) { __req.body = String(v); },
      update(v) { __req.body = typeof v === 'string' ? v : __str(v); },
      toString() { return __req.body; },
    },
    addHeader(h) { this.headers.upsert(h); },
    removeHeader(k) { this.headers.remove(k); },
  },
  test(name, fn) {
    const rec = { name: String(name), passed: true };
    __tests.push(rec);
    try {
      const r = fn();
      if (r && typeof r.then === 'function') r.then(null, (e) => { rec.passed = false; rec.error = e && e.message ? e.message : String(e); });
    } catch (e) { rec.passed = false; rec.error = e && e.message ? e.message : String(e); }
  },
  expect,
  execution: {
    setNextRequest(name) { __next = name === null || name === undefined ? null : String(name); },
    skipRequest() { __skip = true; },
  },
};
pm.test.skip = (name) => { __tests.push({ name: String(name) + ' (skipped)', passed: true }); };
pm.setNextRequest = pm.execution.setNextRequest;
const postman = { setNextRequest: pm.execution.setNextRequest, setEnvironmentVariable: (k, v) => pm.environment.set(k, v), getEnvironmentVariable: (k) => pm.environment.get(k), setGlobalVariable: (k, v) => pm.globals.set(k, v), getGlobalVariable: (k) => pm.globals.get(k) };

if (__IN.response) {
  const R = __IN.response;
  const hdrs = __headers(R.headers.map((h) => [h[0], h[1]]), false);
  const res = {
    code: R.code,
    status: R.status,
    responseTime: R.responseTime,
    responseSize: R.responseSize,
    headers: hdrs,
    text: () => R.body,
    json: () => JSON.parse(R.body),
  };
  const resAssert = () => {
    const s = { neg: false };
    const c = {};
    const check = (ok, msg) => { if (ok === s.neg) throw AssertionError(s.neg ? 'not: ' + msg : msg); return c; };
    for (const w of ['to', 'be', 'have', 'and', 'that', 'with']) Object.defineProperty(c, w, { get: () => c });
    Object.defineProperty(c, 'not', { get: () => { s.neg = !s.neg; return c; } });
    c.status = (code) => (typeof code === 'number' ? check(R.code === code, 'expected response to have status code ' + code + ' but got ' + R.code) : check(R.status === code, 'expected response status "' + code + '" but got "' + R.status + '"'));
    c.header = (k, v) => check(hdrs.has(k, v), 'expected response to have header ' + k + (v === undefined ? '' : ' with value ' + v));
    c.body = (v) => check(v === undefined ? R.body.length > 0 : (v instanceof RegExp ? v.test(R.body) : R.body === v), 'expected response body to ' + (v === undefined ? 'be non-empty' : 'match ' + __str(v)));
    c.jsonBody = (path, val) => { let j; try { j = JSON.parse(R.body); } catch (e) { return check(false, 'expected response body to be JSON'); } if (path === undefined) return check(true, ''); let cur = j; for (const part of String(path).split('.')) { if (cur == null || !(part in Object(cur))) return check(false, 'expected JSON body to have ' + path); cur = cur[part]; } return val === undefined ? check(true, '') : check(__eq(cur, val), 'expected ' + path + ' to be ' + __str(val) + ' but got ' + __str(cur)); };
    c.responseTime = { below: (n) => check(R.responseTime < n, 'expected response time below ' + n + ' ms but got ' + R.responseTime) };
    Object.defineProperty(c, 'ok', { get: () => check(R.code >= 200 && R.code < 300, 'expected a 2xx response but got ' + R.code) });
    Object.defineProperty(c, 'success', { get: () => check(R.code >= 200 && R.code < 300, 'expected a 2xx response but got ' + R.code) });
    Object.defineProperty(c, 'error', { get: () => check(R.code >= 400, 'expected a 4xx/5xx response but got ' + R.code) });
    Object.defineProperty(c, 'clientError', { get: () => check(R.code >= 400 && R.code < 500, 'expected a 4xx response but got ' + R.code) });
    Object.defineProperty(c, 'serverError', { get: () => check(R.code >= 500, 'expected a 5xx response but got ' + R.code) });
    Object.defineProperty(c, 'notFound', { get: () => check(R.code === 404, 'expected 404 but got ' + R.code) });
    Object.defineProperty(c, 'json', { get: () => { let ok = true; try { JSON.parse(R.body); } catch (e) { ok = false; } return check(ok, 'expected response body to be JSON'); } });
    return c;
  };
  Object.defineProperty(res, 'to', { get: () => resAssert().to });
  pm.response = res;
  // Legacy globals some old Postman scripts still use.
  globalThis.responseBody = R.body;
  globalThis.responseCode = { code: R.code, name: R.status };
}

function __OUT() {
  return JSON.stringify({ vars: __vars, request: __req, tests: __tests, console: __console, nextRequest: __next, skipRequest: __skip });
}
`;
