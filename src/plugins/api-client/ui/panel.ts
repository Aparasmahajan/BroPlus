// API client panel (Postman-class). Vanilla TS over the generic plugin bus.
// Request builder (params/headers/auth/body) + variable substitution + saved
// collections + environments + response viewer with a diff tab + history.
import type { HttpExchange, HttpRequest, Header } from '../../../shared/ipc-contract';
import type { ApiState, Collection, Environment, KeyVal, SavedRequest, BodyMode, AuthKind } from '../../../shared/api-model';
import { newRequest } from '../../../shared/api-model';
import { substituteVars } from '../../../shared/vars';
import { diffLines, prettyForDiff } from '../../diff';

const bro = window.bro;
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const q = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
/** crypto.randomUUID needs a secure context; file:// may not be one. */
function genId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

// --- State -----------------------------------------------------------------
let state: ApiState = { collections: [], environments: [], activeEnvId: null };
let cur: SavedRequest = newRequest();
let lastExchange: HttpExchange | null = null;
let resView: 'body' | 'headers' | 'diff' = 'body';
const prevBodyByKey = new Map<string, string>(); // for diff across sends

// --- Elements --------------------------------------------------------------
const methodEl = $<HTMLSelectElement>('method');
const urlEl = $<HTMLInputElement>('url');
const bodyEl = $<HTMLTextAreaElement>('body');
const nameEl = $<HTMLInputElement>('req-name');
const envEl = $<HTMLSelectElement>('env');
const saveColEl = $<HTMLSelectElement>('save-col');
const authKindEl = $<HTMLSelectElement>('auth-kind');
const out = $('out');
const statusEl = $('status');
const timeEl = $('time');
const sizeEl = $('size');
const treeEl = $('tree');

// ========================================================================
// Key/value row editor
// ========================================================================
function renderKV(container: HTMLElement, rows: KeyVal[]): void {
  container.replaceChildren();
  rows.forEach((row, i) => {
    const line = document.createElement('div');
    line.className = 'kv';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = row.on;
    chk.addEventListener('change', () => (row.on = chk.checked));

    const k = document.createElement('input');
    k.placeholder = 'key';
    k.value = row.key;
    k.spellcheck = false;
    k.addEventListener('input', () => (row.key = k.value));

    const v = document.createElement('input');
    v.placeholder = 'value';
    v.value = row.value;
    v.spellcheck = false;
    v.addEventListener('input', () => (row.value = v.value));

    const del = document.createElement('button');
    del.className = 'kv-del';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      rows.splice(i, 1);
      renderKV(container, rows);
    });

    line.append(chk, k, v, del);
    container.appendChild(line);
  });

  const add = document.createElement('button');
  add.className = 'kv-add';
  add.textContent = '+ add';
  add.addEventListener('click', () => {
    rows.push({ key: '', value: '', on: true });
    renderKV(container, rows);
  });
  container.appendChild(add);
}

// ========================================================================
// Request tabs
// ========================================================================
document.querySelectorAll<HTMLButtonElement>('.rtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rtab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const rt = btn.dataset.rt;
    document.querySelectorAll<HTMLElement>('[data-rtp]').forEach((p) => {
      p.hidden = p.dataset.rtp !== rt;
    });
  });
});

function renderAuthFields(): void {
  const wrap = $('auth-fields');
  wrap.replaceChildren();
  authKindEl.value = cur.auth.kind;
  const field = (label: string, val: string, on: (v: string) => void, type = 'text') => {
    const l = document.createElement('label');
    l.className = 'auth-field';
    l.textContent = label;
    const inp = document.createElement('input');
    inp.type = type;
    inp.value = val;
    inp.spellcheck = false;
    inp.addEventListener('input', () => on(inp.value));
    l.appendChild(inp);
    wrap.appendChild(l);
  };
  if (cur.auth.kind === 'bearer') field('Token', cur.auth.token ?? '', (v) => (cur.auth.token = v));
  if (cur.auth.kind === 'basic') {
    field('Username', cur.auth.username ?? '', (v) => (cur.auth.username = v));
    field('Password', cur.auth.password ?? '', (v) => (cur.auth.password = v), 'password');
  }
}
authKindEl.addEventListener('change', () => {
  cur.auth = { kind: authKindEl.value as AuthKind };
  renderAuthFields();
});

function renderBodyMode(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="bm"]').forEach((r) => {
    r.checked = r.value === cur.bodyMode;
  });
  bodyEl.hidden = !(cur.bodyMode === 'json' || cur.bodyMode === 'text');
  const formRows = $('form-rows');
  formRows.hidden = cur.bodyMode !== 'form';
  if (cur.bodyMode === 'form') renderKV(formRows, cur.form);
}
document.querySelectorAll<HTMLInputElement>('input[name="bm"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (r.checked) {
      cur.bodyMode = r.value as BodyMode;
      renderBodyMode();
    }
  });
});
bodyEl.addEventListener('input', () => (cur.body = bodyEl.value));

// ========================================================================
// Load / reflect a request into the form
// ========================================================================
function loadRequest(req: SavedRequest): void {
  cur = JSON.parse(JSON.stringify(req)) as SavedRequest; // working copy
  methodEl.value = cur.method;
  urlEl.value = cur.url;
  nameEl.value = cur.name;
  bodyEl.value = cur.body;
  renderKV(q('[data-rtp="params"]'), cur.params);
  renderKV(q('[data-rtp="headers"]'), cur.headers);
  renderAuthFields();
  renderBodyMode();
}
function syncFromForm(): void {
  cur.method = methodEl.value;
  cur.url = urlEl.value;
  cur.name = nameEl.value || 'Untitled';
  cur.body = bodyEl.value;
}

// ========================================================================
// Build the wire request (resolve vars, params, auth, body)
// ========================================================================
function activeVars(): Record<string, string> {
  const env = state.environments.find((e) => e.id === state.activeEnvId);
  const map: Record<string, string> = {};
  if (env) for (const v of env.vars) if (v.on && v.key) map[v.key] = v.value;
  return map;
}

function buildRequest(): HttpRequest {
  syncFromForm();
  const vars = activeVars();
  const sub = (s: string) => substituteVars(s, vars);

  // URL + query params.
  let url = sub(cur.url).trim();
  const qp = cur.params.filter((p) => p.on && p.key).map((p) => `${encodeURIComponent(sub(p.key))}=${encodeURIComponent(sub(p.value))}`);
  if (qp.length) url += (url.includes('?') ? '&' : '?') + qp.join('&');

  // Headers.
  const headers: Header[] = cur.headers.filter((h) => h.on && h.key).map((h) => [sub(h.key), sub(h.value)] as Header);

  // Auth.
  if (cur.auth.kind === 'bearer' && cur.auth.token) headers.push(['Authorization', `Bearer ${sub(cur.auth.token)}`]);
  if (cur.auth.kind === 'basic') {
    const u = sub(cur.auth.username ?? '');
    const p = sub(cur.auth.password ?? '');
    headers.push(['Authorization', `Basic ${btoa(`${u}:${p}`)}`]);
  }

  // Body.
  let body: HttpRequest['body'];
  const hasCT = headers.some(([k]) => k.toLowerCase() === 'content-type');
  if (cur.bodyMode === 'json') {
    body = { kind: 'json', text: sub(cur.body) };
    if (!hasCT) headers.push(['Content-Type', 'application/json']);
  } else if (cur.bodyMode === 'text') {
    body = { kind: 'text', text: sub(cur.body) };
  } else if (cur.bodyMode === 'form') {
    const enc = cur.form.filter((f) => f.on && f.key).map((f) => `${encodeURIComponent(sub(f.key))}=${encodeURIComponent(sub(f.value))}`).join('&');
    body = { kind: 'form', text: enc };
    if (!hasCT) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  }

  return { method: cur.method, url, headers, body };
}

// ========================================================================
// Send + response rendering
// ========================================================================
function b64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
function keyOf(ex: HttpExchange): string {
  return `${ex.request.method} ${ex.request.url.split('?')[0]}`;
}

function renderResponse(): void {
  document.querySelectorAll<HTMLButtonElement>('.res-head .seg').forEach((b) =>
    b.classList.toggle('active', b.id === `t-${resView}`),
  );
  if (!lastExchange?.response) {
    out.textContent = '';
    return;
  }
  const r = lastExchange.response;
  if (resView === 'headers') {
    out.textContent = r.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
  } else if (resView === 'diff') {
    const key = keyOf(lastExchange);
    const prev = prevBodyByKey.get(key);
    const curBody = prettyForDiff(b64ToText(r.body.b64));
    if (prev === undefined) {
      out.textContent = '(no previous response for this request yet — send again to compare)';
    } else {
      out.replaceChildren();
      for (const line of diffLines(prev, curBody)) {
        const d = document.createElement('div');
        d.className = `dl ${line.type}`;
        d.textContent = (line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ') + line.text;
        out.appendChild(d);
      }
    }
  } else {
    const text = b64ToText(r.body.b64);
    out.textContent = pretty(text) + (r.body.truncatedBytes ? `\n\n… +${r.body.truncatedBytes} bytes truncated` : '');
  }
}

document.querySelectorAll<HTMLButtonElement>('.res-head .seg').forEach((b) => {
  b.addEventListener('click', () => {
    resView = b.id.replace('t-', '') as 'body' | 'headers' | 'diff';
    renderResponse();
  });
});

async function send(): Promise<void> {
  const req = buildRequest();
  if (!req.url) return;
  const sendBtn = $<HTMLButtonElement>('send');
  sendBtn.disabled = true;
  statusEl.textContent = '…';
  statusEl.className = 'status';
  timeEl.textContent = '';
  sizeEl.textContent = '';
  out.textContent = '';
  try {
    const ex = await bro.plugin.invoke<HttpExchange>('api:send', req);
    const r = ex.response!;
    // Record previous body for diff BEFORE replacing lastExchange.
    if (lastExchange?.response && keyOf(lastExchange) === keyOf(ex)) {
      prevBodyByKey.set(keyOf(ex), prettyForDiff(b64ToText(lastExchange.response.body.b64)));
    }
    lastExchange = ex;
    statusEl.textContent = String(r.status);
    statusEl.className = 'status ' + (r.status < 400 ? 'ok' : 'bad');
    timeEl.textContent = `${r.timingMs} ms`;
    sizeEl.textContent = `${fmtBytes(atob(r.body.b64).length)}`;
    resView = 'body';
    renderResponse();
  } catch (e) {
    statusEl.textContent = 'error';
    statusEl.className = 'status bad';
    out.textContent = String(e);
  } finally {
    sendBtn.disabled = false;
  }
}
function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}
$('send').addEventListener('click', () => void send());
urlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void send();
});

// ========================================================================
// Collections + environments (sidebar)
// ========================================================================
function renderEnvSelect(): void {
  envEl.replaceChildren();
  const none = new Option('No environment', '');
  envEl.appendChild(none);
  for (const e of state.environments) envEl.appendChild(new Option(e.name, e.id));
  envEl.value = state.activeEnvId ?? '';
}
envEl.addEventListener('change', () => {
  void bro.plugin.invoke('api:set-active-env', envEl.value || null).then(reload);
});

function renderSaveCol(): void {
  saveColEl.replaceChildren();
  if (!state.collections.length) saveColEl.appendChild(new Option('(no collection)', ''));
  for (const c of state.collections) saveColEl.appendChild(new Option(c.name, c.id));
}

function renderTree(): void {
  treeEl.replaceChildren();
  if (!state.collections.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'No collections yet. Build a request and press Save.';
    treeEl.appendChild(empty);
    return;
  }
  for (const col of state.collections) {
    const head = document.createElement('div');
    head.className = 'tree-col';
    const title = document.createElement('span');
    title.textContent = col.name;
    const del = document.createElement('button');
    del.className = 'kv-del';
    del.textContent = '✕';
    del.title = 'Delete collection';
    del.addEventListener('click', () => void bro.plugin.invoke('api:delete-collection', col.id).then(reload));
    head.append(title, del);
    treeEl.appendChild(head);

    const all: SavedRequest[] = [...col.requests, ...col.folders.flatMap((f) => f.requests)];
    for (const r of all) {
      const item = document.createElement('div');
      item.className = 'tree-req';
      item.innerHTML = `<span class="m m-${r.method.toLowerCase()}">${r.method}</span>`;
      const label = document.createElement('span');
      label.className = 'tree-req-name';
      label.textContent = r.name;
      item.appendChild(label);
      item.addEventListener('click', () => {
        loadRequest(r);
        saveColEl.value = col.id;
      });
      treeEl.appendChild(item);
    }
  }
}

function renderHistory(): void {
  treeEl.replaceChildren();
  void bro.plugin.invoke<HttpExchange[]>('api:history').then((hist) => {
    if (!hist.length) {
      const e = document.createElement('div');
      e.className = 'tree-empty';
      e.textContent = 'No requests sent yet.';
      treeEl.appendChild(e);
      return;
    }
    for (const ex of hist) {
      const item = document.createElement('div');
      item.className = 'tree-req';
      const st = ex.response?.status ?? 0;
      item.innerHTML = `<span class="m m-${ex.request.method.toLowerCase()}">${ex.request.method}</span><span class="h-st ${st < 400 ? 'ok' : 'bad'}">${st || '—'}</span>`;
      const label = document.createElement('span');
      label.className = 'tree-req-name';
      label.textContent = ex.request.url;
      item.appendChild(label);
      item.addEventListener('click', () => {
        methodEl.value = ex.request.method;
        urlEl.value = ex.request.url;
        lastExchange = ex;
        resView = 'body';
        if (ex.response) {
          statusEl.textContent = String(ex.response.status);
          statusEl.className = 'status ' + (ex.response.status < 400 ? 'ok' : 'bad');
          timeEl.textContent = `${ex.response.timingMs} ms`;
        }
        renderResponse();
      });
      treeEl.appendChild(item);
    }
  });
}

// Sidebar buttons
$('view-collections').addEventListener('click', () => {
  $('view-collections').classList.add('active');
  $('view-history').classList.remove('active');
  renderTree();
});
$('view-history').addEventListener('click', () => {
  $('view-history').classList.add('active');
  $('view-collections').classList.remove('active');
  renderHistory();
});

$('col-new').addEventListener('click', () => {
  const col: Collection = { id: '', name: `Collection ${state.collections.length + 1}`, folders: [], requests: [] };
  void bro.plugin.invoke('api:save-collection', col).then(reload);
});

$('req-save').addEventListener('click', () => {
  syncFromForm();
  const colId = saveColEl.value;
  const col = state.collections.find((c) => c.id === colId);
  if (!col) {
    // No collection selected/exists → make one, then the user can Save again.
    void bro.plugin.invoke('api:save-collection', { id: '', name: 'My Collection', folders: [], requests: [] }).then(reload);
    return;
  }
  if (!cur.id) cur.id = genId();
  const copy = JSON.parse(JSON.stringify(cur)) as SavedRequest;
  const idx = col.requests.findIndex((r) => r.id === copy.id);
  if (idx >= 0) col.requests[idx] = copy;
  else col.requests.push(copy);
  void bro.plugin.invoke('api:save-collection', col).then(reload);
});

$('env-new').addEventListener('click', () => {
  const env: Environment = { id: '', name: `Env ${state.environments.length + 1}`, vars: [] };
  void bro.plugin.invoke<Environment>('api:save-environment', env).then((saved) =>
    bro.plugin.invoke('api:set-active-env', saved.id).then(() => reload().then(editEnv)),
  );
});
$('env-edit').addEventListener('click', editEnv);

function editEnv(): void {
  const env = state.environments.find((e) => e.id === state.activeEnvId);
  if (!env) return;
  treeEl.replaceChildren();

  const nameRow = document.createElement('div');
  nameRow.className = 'side-row';
  const name = document.createElement('input');
  name.className = 'grow';
  name.value = env.name;
  name.addEventListener('input', () => (env.name = name.value));
  nameRow.appendChild(name);
  treeEl.appendChild(nameRow);

  const varsWrap = document.createElement('div');
  varsWrap.className = 'kv-wrap';
  renderKV(varsWrap, env.vars);
  treeEl.appendChild(varsWrap);

  const actions = document.createElement('div');
  actions.className = 'side-row';
  const save = document.createElement('button');
  save.className = 'mini-btn grow';
  save.textContent = 'Save env';
  save.addEventListener('click', () => void bro.plugin.invoke('api:save-environment', env).then(reload));
  const del = document.createElement('button');
  del.className = 'mini-btn';
  del.textContent = 'Delete';
  del.addEventListener('click', () => void bro.plugin.invoke('api:delete-environment', env.id).then(reload));
  actions.append(save, del);
  treeEl.appendChild(actions);
}

// ========================================================================
// Boot
// ========================================================================
async function reload(): Promise<void> {
  state = await bro.plugin.invoke<ApiState>('api:state');
  renderEnvSelect();
  renderSaveCol();
  if ($('view-history').classList.contains('active')) renderHistory();
  else renderTree();
}

loadRequest(newRequest());
void reload();
