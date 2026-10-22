// API client panel (Postman-class). Vanilla TS over the generic plugin bus.
//
// The panel only EDITS and SHOWS: every send, script, secret, file and cookie is
// handled by the plugin's main half (main.ts → runner/resolve/sandbox/engine).
// Layout: sidebar (collections tree · environments · history), open-request tabs,
// request editor (params, auth, headers, body, scripts, settings) and response
// viewer (pretty/raw/preview body, headers, cookies, tests, console, the request
// actually sent, diff vs the previous send). Dialogs: save, import, runner,
// cookies, vault, variables, code snippets, collection/folder/environment editors.
import type { HttpExchange, HttpRequest } from '../../../shared/ipc-contract';
import {
  DEFAULT_SETTINGS,
  emptyOAuth2,
  findFolder,
  findRequest,
  newCollection,
  newFolder,
  newRequest,
  normalizeRequest,
  type ApiState,
  type Auth,
  type AuthKind,
  type BodyMode,
  type Collection,
  type Environment,
  type Folder,
  type KeyVal,
  type RunResult,
  type RunnerSummary,
  type SavedRequest,
  type Scripts,
} from '../../../shared/api-model';
import { looksLikeCurl, parseCurl } from '../../../shared/curl';
import { SNIPPET_LANGS, snippet, type SnippetLang } from '../../../shared/codegen';
import { scopeOf } from '../../../shared/vars';
import { diffLines, prettyForDiff } from '../../diff';

const bro = window.bro;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
type Child = Node | string | null | false | undefined;
/** Tiny DOM builder: h('div', { className: 'x', onclick }, child, 'text'). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('aria') || k === 'role') el.setAttribute(k, String(v));
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
/** Drop null/false so optional children can be passed to append/replaceChildren. */
const nodes = (...xs: (Node | null | false | undefined)[]): Node[] => xs.filter((x): x is Node => !!x);
const invoke = <T>(ch: string, arg?: unknown) => bro.plugin.invoke<T>(ch, arg);
function genId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ============================================================================
// State
// ============================================================================
type ReqTab = 'params' | 'auth' | 'headers' | 'body' | 'pre' | 'test' | 'settings';
type ResTab = 'body' | 'headers' | 'cookies' | 'tests' | 'console' | 'sent' | 'diff';

interface OpenTab {
  key: string;
  req: SavedRequest;
  /** Where it belongs (saved requests: their collection; new ones: where they'll be saved). */
  collectionId?: string;
  folderId?: string;
  /** Snapshot when last saved/opened — differs → unsaved changes dot. */
  saved: string;
  result?: RunResult;
  prevBody?: string;
  sending?: boolean;
  reqTab: ReqTab;
  resTab: ResTab;
  bodyView: 'pretty' | 'raw' | 'preview';
}

let state: ApiState = { collections: [], environments: [], activeEnvId: null, globals: [], vaultKeys: [], proxy: { available: false, running: false } };
let tabs: OpenTab[] = [];
let activeKey = '';
let side: 'collections' | 'environments' | 'history' = 'collections';
const expanded = new Set<string>();
let history: HttpExchange[] = [];

const cur = (): OpenTab => tabs.find((t) => t.key === activeKey) ?? tabs[0];
const isDirty = (t: OpenTab) => JSON.stringify(t.req) !== t.saved;

// ============================================================================
// Toast, menu, modal
// ============================================================================
let toastTimer = 0;
function toast(text: string, err = false): void {
  const t = $('toast');
  t.textContent = text;
  t.className = 'ap-toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), err ? 6000 : 2600);
}

interface MenuItem {
  label: string;
  run?: () => void;
  danger?: boolean;
  sep?: boolean;
}
function menu(at: HTMLElement | { x: number; y: number }, items: MenuItem[]): void {
  const m = $('menu');
  m.replaceChildren(
    ...items.map((it) =>
      it.sep
        ? h('hr')
        : h('button', {
            className: it.danger ? 'danger' : '',
            textContent: it.label,
            onclick: () => {
              m.hidden = true;
              it.run?.();
            },
          }),
    ),
  );
  m.hidden = false;
  const r = at instanceof HTMLElement ? at.getBoundingClientRect() : { left: at.x, bottom: at.y, top: at.y };
  const w = m.offsetWidth;
  const hgt = m.offsetHeight;
  m.style.left = `${Math.min(r.left, innerWidth - w - 8)}px`;
  m.style.top = `${r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt) : r.bottom + 2}px`;
}
document.addEventListener('mousedown', (e) => {
  const m = $('menu');
  if (!m.hidden && !m.contains(e.target as Node)) m.hidden = true;
});

let modalClose: (() => void) | null = null;
function modal(title: string, body: Child | Child[], foot: Child[] = [], onClose?: () => void): void {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren(...[body].flat().filter((x): x is Node | string => x != null && x !== false));
  $('modal-foot').replaceChildren(...foot.filter((x): x is Node | string => x != null && x !== false));
  $('modal-foot').hidden = foot.length === 0;
  $('modal').hidden = false;
  modalClose = onClose ?? null;
}
function closeModal(): void {
  $('modal').hidden = true;
  const fn = modalClose;
  modalClose = null;
  fn?.();
}
$('modal-x').addEventListener('click', closeModal);
$('modal').addEventListener('mousedown', (e) => {
  if (e.target === $('modal')) closeModal();
});

// ============================================================================
// Generic editors
// ============================================================================
interface KvOpts {
  /** Env/global editor: per-row "secret" toggle. */
  secrets?: boolean;
  /** Multipart: text/file type column + file picker. */
  files?: boolean;
  placeholderKey?: string;
  onChange?: () => void;
}

/** Postman-style key/value table with enable checkboxes and a bulk-edit mode. */
function kvEditor(rows: KeyVal[], opts: KvOpts = {}): HTMLElement {
  const wrap = h('div');
  let bulk = false;
  const changed = () => opts.onChange?.();
  const render = () => {
    const tools = h(
      'div',
      { className: 'kv-tools' },
      h('span', { className: 'muted small' }, `${rows.filter((r) => r.on && r.key).length} active`),
      h('button', {
        className: 'btn ghost sm',
        textContent: bulk ? 'Key-value edit' : 'Bulk edit',
        onclick: () => {
          bulk = !bulk;
          render();
        },
      }),
    );
    if (bulk) {
      const ta = h('textarea', {
        className: 'bulk mono',
        spellcheck: false,
        value: rows.map((r) => `${r.on ? '' : '//'}${r.key}:${r.value}`).join('\n'),
        placeholder: 'key:value — one per line; // disables a row',
      });
      ta.addEventListener('input', () => {
        const next = ta.value
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            const off = l.trimStart().startsWith('//');
            const line = off ? l.trimStart().slice(2) : l;
            const c = line.indexOf(':');
            const key = (c >= 0 ? line.slice(0, c) : line).trim();
            const old = rows.find((r) => r.key === key);
            return { ...(old ?? {}), key, value: c >= 0 ? line.slice(c + 1).trim() : '', on: !off } as KeyVal;
          });
        rows.splice(0, rows.length, ...next);
        changed();
      });
      wrap.replaceChildren(tools, ta);
      return;
    }
    const table = h(
      'table',
      { className: 'kvt' },
      h(
        'thead',
        {},
        h('tr', {}, h('th', {}), h('th', {}, 'Key'), opts.files ? h('th', { style: '' }, 'Type') : null, h('th', {}, 'Value'), h('th', {})),
      ),
    );
    const tbody = h('tbody');
    const rowEl = (r: KeyVal | null, i: number) => {
      const isNew = r === null;
      const row: KeyVal = r ?? { key: '', value: '', on: true, ...(opts.files ? { type: 'text' as const } : {}) };
      const tr = h('tr', { className: row.on ? '' : 'off' });
      const commitNew = () => {
        if (isNew && (row.key || row.value)) {
          rows.push(row);
          render();
          changed();
          const inputs = wrap.querySelectorAll<HTMLInputElement>('tbody tr:nth-last-child(2) input[type="text"]');
          (document.activeElement as HTMLInputElement | null)?.blur();
          inputs[row.value && !row.key ? 1 : 0]?.focus();
        }
      };
      const chk = h('input', { type: 'checkbox', checked: row.on, disabled: isNew });
      chk.addEventListener('change', () => {
        row.on = chk.checked;
        tr.className = row.on ? '' : 'off';
        changed();
      });
      const key = h('input', { type: 'text', value: row.key, placeholder: opts.placeholderKey ?? 'Key', spellcheck: false });
      key.addEventListener('input', () => {
        row.key = key.value;
        if (isNew) commitNew();
        else changed();
      });
      const valType = row.secret ? 'password' : 'text';
      const val = h('input', { type: valType, value: row.value, placeholder: row.type === 'file' ? 'File path' : 'Value', spellcheck: false });
      val.addEventListener('input', () => {
        row.value = val.value;
        if (isNew) commitNew();
        else changed();
      });
      if (row.secret) {
        val.addEventListener('focus', () => (val.type = 'text'));
        val.addEventListener('blur', () => (val.type = 'password'));
      }
      const valCell = h('td', {}, val);
      if (opts.files && row.type === 'file') {
        valCell.append(
          h('button', {
            className: 'btn sm',
            textContent: 'Choose…',
            onclick: async () => {
              const p = await invoke<string | null>('api:pick-file', { purpose: 'multipart' });
              if (p) {
                row.value = p;
                val.value = p;
                if (isNew) commitNew();
                else changed();
              }
            },
          }),
        );
        valCell.style.display = 'flex';
      }
      let typeCell: HTMLElement | null = null;
      if (opts.files) {
        const sel = h('select', {}, h('option', { value: 'text', textContent: 'Text' }), h('option', { value: 'file', textContent: 'File' }));
        sel.value = row.type ?? 'text';
        sel.addEventListener('change', () => {
          row.type = sel.value as 'text' | 'file';
          if (isNew) rows.push(row);
          render();
          changed();
        });
        typeCell = h('td', { style: 'width:80px' }, sel);
      }
      const act = h('td', { className: 'act' });
      if (opts.secrets && !isNew) {
        act.append(
          h('button', {
            className: 'del',
            title: row.secret ? 'Secret (masked) — click to show as plain' : 'Mark as secret (masked)',
            textContent: row.secret ? '🔒' : '🔓',
            onclick: () => {
              row.secret = !row.secret || undefined;
              render();
              changed();
            },
          }),
        );
      }
      if (!isNew) {
        act.append(
          h('button', {
            className: 'del',
            title: 'Delete row',
            textContent: '✕',
            onclick: () => {
              rows.splice(i, 1);
              render();
              changed();
            },
          }),
        );
      }
      tr.append(...nodes(h('td', { className: 'chk' }, chk), h('td', {}, key), typeCell, valCell, act));
      return tr;
    };
    rows.forEach((r, i) => tbody.append(rowEl(r, i)));
    tbody.append(rowEl(null, rows.length));
    table.append(tbody);
    wrap.replaceChildren(tools, table);
  };
  render();
  return wrap;
}

/** A code/text area where Tab indents instead of leaving the field. */
function codeArea(value: string, onInput: (v: string) => void, cls = 'code', placeholder = ''): HTMLTextAreaElement {
  const ta = h('textarea', { className: `${cls} mono`, spellcheck: false, value, placeholder });
  ta.addEventListener('input', () => onInput(ta.value));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = ta;
      ta.setRangeText('  ', s, en, 'end');
      onInput(ta.value);
    }
  });
  return ta;
}

function switchRow(label: string, hint: string, control: HTMLElement): HTMLElement {
  return h('div', { className: 'switch-row' }, h('div', {}, label, h('small', {}, hint)), control);
}
function checkbox(checked: boolean, onChange: (v: boolean) => void, disabled = false): HTMLInputElement {
  const c = h('input', { type: 'checkbox', checked, disabled });
  c.addEventListener('change', () => onChange(c.checked));
  return c;
}

// ============================================================================
// Auth editor (requests, folders, collections)
// ============================================================================
const AUTH_LABELS: Record<AuthKind, string> = {
  inherit: 'Inherit auth from parent',
  none: 'No Auth',
  bearer: 'Bearer Token',
  basic: 'Basic Auth',
  apikey: 'API Key',
  oauth2: 'OAuth 2.0',
};

function authEditor(get: () => Auth, set: (a: Auth) => void, opts: { allowInherit: boolean; inheritFrom?: () => string; collectionId?: () => string | undefined; onChange: () => void }): HTMLElement {
  const wrap = h('div');
  const render = () => {
    const a = get();
    const kinds = (Object.keys(AUTH_LABELS) as AuthKind[]).filter((k) => k !== 'inherit' || opts.allowInherit);
    const sel = h('select', {}, ...kinds.map((k) => h('option', { value: k, textContent: AUTH_LABELS[k] })));
    sel.value = a.kind;
    sel.addEventListener('change', () => {
      const kind = sel.value as AuthKind;
      set(kind === 'oauth2' ? { kind, oauth2: a.oauth2 ?? emptyOAuth2() } : { ...a, kind });
      opts.onChange();
      render();
    });
    const grid = h('div', { className: 'form-grid' }, h('label', {}, 'Type'), sel);
    const field = (label: string, value: string, onInput: (v: string) => void, type = 'text') => {
      const inp = h('input', { type, value, spellcheck: false, className: 'mono' });
      inp.addEventListener('input', () => {
        onInput(inp.value);
        opts.onChange();
      });
      grid.append(h('label', {}, label), inp);
      return inp;
    };
    const choice = (label: string, value: string, options: [string, string][], onPick: (v: string) => void) => {
      const s = h('select', {}, ...options.map(([v, t]) => h('option', { value: v, textContent: t })));
      s.value = value;
      s.addEventListener('change', () => {
        onPick(s.value);
        opts.onChange();
      });
      grid.append(h('label', {}, label), s);
    };
    const children: Child[] = [grid];
    switch (a.kind) {
      case 'inherit':
        children.push(h('p', { className: 'note inherit' }, opts.inheritFrom?.() ?? 'Uses the auth of the folder or collection it is in.'));
        break;
      case 'bearer':
        field('Token', a.token ?? '', (v) => (a.token = v));
        break;
      case 'basic':
        field('Username', a.username ?? '', (v) => (a.username = v));
        field('Password', a.password ?? '', (v) => (a.password = v), 'password');
        break;
      case 'apikey':
        field('Key', a.key ?? '', (v) => (a.key = v));
        field('Value', a.value ?? '', (v) => (a.value = v));
        choice('Add to', a.in ?? 'header', [['header', 'Header'], ['query', 'Query params']], (v) => (a.in = v as 'header' | 'query'));
        break;
      case 'oauth2': {
        const o = (a.oauth2 ??= emptyOAuth2());
        const tok = field('Access token', o.accessToken, (v) => (o.accessToken = v));
        field('Header prefix', o.headerPrefix, (v) => (o.headerPrefix = v));
        grid.append(h('label', { style: 'grid-column: 1 / -1; padding-top: 10px; font-weight: 600; color: var(--text)' }, 'Get a new access token'));
        choice('Grant type', o.grant, [['client_credentials', 'Client Credentials'], ['password', 'Password Credentials']], (v) => {
          o.grant = v as typeof o.grant;
          render();
        });
        field('Access token URL', o.tokenUrl, (v) => (o.tokenUrl = v));
        field('Client ID', o.clientId, (v) => (o.clientId = v));
        field('Client secret', o.clientSecret, (v) => (o.clientSecret = v), 'password');
        field('Scope', o.scope, (v) => (o.scope = v));
        if (o.grant === 'password') {
          field('Username', o.username, (v) => (o.username = v));
          field('Password', o.password, (v) => (o.password = v), 'password');
        }
        choice('Client authentication', o.clientAuth, [['basic', 'Send as Basic Auth header'], ['body', 'Send client credentials in body']], (v) => (o.clientAuth = v as 'basic' | 'body'));
        const btn = h('button', { className: 'btn primary', textContent: 'Get new access token' });
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Requesting…';
          const r = await invoke<{ accessToken?: string; error?: string }>('api:oauth2-token', { oauth2: o, collectionId: opts.collectionId?.() });
          btn.disabled = false;
          btn.textContent = 'Get new access token';
          if (r.accessToken) {
            o.accessToken = r.accessToken;
            tok.value = r.accessToken;
            opts.onChange();
            toast('Access token received');
          } else toast(r.error ?? 'Token request failed', true);
        });
        grid.append(h('span'), h('div', {}, btn));
        break;
      }
    }
    if (a.kind !== 'none' && a.kind !== 'inherit') {
      children.push(h('p', { className: 'note' }, 'Values can use ', h('code', {}, '{{variables}}'), ' and secrets like ', h('code', {}, '${vault:name}'), ' / ', h('code', {}, '${env:NAME}'), ' — secrets are expanded only when sending, never saved in the collection file.'));
    }
    wrap.replaceChildren(...children.filter((c): c is Node => c instanceof Node));
  };
  render();
  return wrap;
}

function describeAuth(a: Auth): string {
  return AUTH_LABELS[a.kind] ?? a.kind;
}

/** Where an "inherit" request's auth actually comes from, in words. */
function inheritedAuthText(t: OpenTab): string {
  const col = state.collections.find((c) => c.id === t.collectionId) ?? (t.req.id ? findRequest(state.collections, t.req.id)?.collection : undefined);
  if (!col) return 'This request is not in a collection yet, so “inherit” means no auth. Save it into a collection to inherit its auth.';
  const loc = t.req.id ? findRequest(state.collections, t.req.id) : null;
  const folders = loc?.folders ?? (t.folderId ? (() => { const f = findFolder(col, t.folderId!); return f ? [...f.chain, f.folder] : []; })() : []);
  for (let i = folders.length - 1; i >= 0; i--) {
    const a = folders[i].auth;
    if (a && a.kind !== 'inherit') return `Using ${describeAuth(a)} from folder “${folders[i].name}”.`;
  }
  const a = col.auth;
  return a && a.kind !== 'inherit' && a.kind !== 'none' ? `Using ${describeAuth(a)} from collection “${col.name}”.` : `Collection “${col.name}” has no auth, so none is sent.`;
}

// ============================================================================
// Script editor with Postman's snippet list
// ============================================================================
const SNIPPETS: Record<'pre' | 'test', [string, string][]> = {
  pre: [
    ['Set an environment variable', `pm.environment.set("variable_key", "variable_value");`],
    ['Set a global variable', `pm.globals.set("variable_key", "variable_value");`],
    ['Set a collection variable', `pm.collectionVariables.set("variable_key", "variable_value");`],
    ['Get a variable', `const value = pm.variables.get("variable_key");`],
    ['Add a header', `pm.request.headers.upsert({ key: "X-Request-Id", value: "{{$guid}}" });`],
    ['Timestamp variable', `pm.variables.set("now", String(Date.now()));`],
    ['Log the request', `console.log(pm.request.method, pm.request.url);`],
  ],
  test: [
    ['Status code is 200', `pm.test("Status code is 200", function () {\n  pm.response.to.have.status(200);\n});`],
    ['Response time is less than 500ms', `pm.test("Response time is less than 500ms", function () {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});`],
    ['Response body: JSON value check', `pm.test("Your test name", function () {\n  const jsonData = pm.response.json();\n  pm.expect(jsonData.value).to.eql(100);\n});`],
    ['Response body: contains string', `pm.test("Body matches string", function () {\n  pm.expect(pm.response.text()).to.include("string_you_want_to_search");\n});`],
    ['Content-Type header is present', `pm.test("Content-Type is present", function () {\n  pm.response.to.have.header("Content-Type");\n});`],
    ['Save a value from the response', `const json = pm.response.json();\npm.environment.set("token", json.token);`],
    ['Set next request (runner)', `pm.execution.setNextRequest("request_name");`],
    ['Stop the run (runner)', `pm.execution.setNextRequest(null);`],
  ],
};

function scriptEditor(which: 'pre' | 'test', scripts: Scripts, onChange: () => void): HTMLElement {
  const ta = codeArea(scripts[which] ?? '', (v) => {
    scripts[which] = v;
    onChange();
  }, 'code', which === 'pre' ? '// Runs before the request is sent. pm.environment.set(…), pm.request.headers.upsert(…)' : '// Runs after the response arrives. pm.test("…", () => pm.response.to.have.status(200));');
  const snips = h(
    'div',
    { className: 'snips' },
    h('h4', {}, 'Snippets'),
    ...SNIPPETS[which].map(([label, code]) =>
      h('button', {
        textContent: label,
        onclick: () => {
          const s = ta.selectionStart;
          const pre = ta.value && !ta.value.endsWith('\n') && s === ta.value.length ? '\n' : '';
          ta.setRangeText(`${pre}${code}\n`, s, ta.selectionEnd, 'end');
          scripts[which] = ta.value;
          onChange();
          ta.focus();
        },
      }),
    ),
    h('p', { className: 'muted small' }, 'Scripts run in a locked sandbox (QuickJS): no files, network or require(). 3 s and 64 MB per script.'),
  );
  return h('div', { className: 'script-wrap' }, ta, snips);
}

// ============================================================================
// Request editor
// ============================================================================
const methodEl = $<HTMLSelectElement>('method');
const urlEl = $<HTMLInputElement>('url');
const nameEl = $<HTMLInputElement>('req-name');
const reqPane = $('req-pane');

/** URL bar shows base + the enabled params as a query string (Postman's two-way sync). */
function urlDisplay(r: SavedRequest): string {
  const q = r.params.filter((p) => p.on && (p.key || p.value)).map((p) => `${p.key}=${p.value}`).join('&');
  return q ? `${r.url}${r.url.includes('?') ? '&' : '?'}${q}` : r.url;
}
function urlFromInput(r: SavedRequest, text: string): void {
  const i = text.indexOf('?');
  r.url = i >= 0 ? text.slice(0, i) : text;
  const parsed: KeyVal[] = i >= 0
    ? text.slice(i + 1).split('&').filter((p) => p !== '').map((p) => {
        const eq = p.indexOf('=');
        return { key: eq >= 0 ? p.slice(0, eq) : p, value: eq >= 0 ? p.slice(eq + 1) : '', on: true };
      })
    : [];
  // Keep descriptions of rows that are still there; keep disabled rows (they're not in the URL).
  const old = r.params;
  r.params = [...parsed.map((p, idx) => ({ ...(old.filter((o) => o.on)[idx] ?? {}), ...p })), ...old.filter((o) => !o.on)];
}

function touched(): void {
  renderTabs();
  updateCounts();
  persistTabs();
}

function updateCounts(): void {
  const t = cur();
  if (!t) return;
  const r = t.req;
  const n = (rows: KeyVal[] | undefined) => (rows ?? []).filter((x) => x.on && x.key).length;
  const counts: Partial<Record<ReqTab, string>> = {
    params: n(r.params) ? String(n(r.params)) : '',
    headers: n(r.headers) ? String(n(r.headers)) : '',
    body: r.bodyMode !== 'none' ? '•' : '',
    pre: r.scripts?.pre?.trim() ? '•' : '',
    test: r.scripts?.test?.trim() ? '•' : '',
    auth: r.auth.kind !== 'inherit' && r.auth.kind !== 'none' ? '•' : '',
  };
  document.querySelectorAll<HTMLButtonElement>('#rtabs button').forEach((b) => {
    const rt = b.dataset.rt as ReqTab;
    const label = b.dataset.label ?? (b.dataset.label = b.textContent ?? '');
    b.replaceChildren(label, counts[rt] ? h('span', { className: 'count' }, counts[rt]!) : '');
    b.classList.toggle('active', rt === t.reqTab);
  });
}

function renderReqPane(): void {
  const t = cur();
  if (!t) return;
  const r = t.req;
  const changed = () => touched();
  let content: HTMLElement;
  switch (t.reqTab) {
    case 'params':
      content = h(
        'div',
        {},
        h('div', { className: 'muted small', style: 'margin-bottom:6px' }, 'Query Params'),
        kvEditor(r.params, {
          onChange: () => {
            urlEl.value = urlDisplay(r);
            changed();
          },
        }),
        h('p', { className: 'note' }, 'Path variables: write ', h('code', {}, '{{id}}'), ' in the URL. Dynamic values: ', h('code', {}, '{{$guid}}'), ' ', h('code', {}, '{{$timestamp}}'), ' ', h('code', {}, '{{$isoTimestamp}}'), ' ', h('code', {}, '{{$randomInt}}'), ' ', h('code', {}, '{{$randomEmail}}'), '…'),
      );
      break;
    case 'headers':
      content = h(
        'div',
        {},
        kvEditor(r.headers, { onChange: changed }),
        h('p', { className: 'note' }, 'Auth, Content-Type (from the body type) and the browser’s cookies for this site are added automatically when sending — see “Request sent” in the response. Your own header of the same name wins.'),
      );
      break;
    case 'auth':
      content = authEditor(() => r.auth, (a) => (r.auth = a), { allowInherit: true, inheritFrom: () => inheritedAuthText(t), collectionId: () => t.collectionId, onChange: changed });
      break;
    case 'body':
      content = bodyEditor(r, changed);
      break;
    case 'pre':
    case 'test':
      r.scripts ??= { pre: '', test: '' };
      content = scriptEditor(t.reqTab, r.scripts, changed);
      break;
    case 'settings':
      content = settingsEditor(r, changed);
      break;
  }
  reqPane.replaceChildren(content);
  updateCounts();
}

const BODY_MODES: [BodyMode, string][] = [
  ['none', 'none'],
  ['json', 'JSON'],
  ['text', 'Text'],
  ['xml', 'XML'],
  ['form', 'x-www-form-urlencoded'],
  ['multipart', 'form-data'],
  ['binary', 'binary'],
  ['graphql', 'GraphQL'],
];

function bodyEditor(r: SavedRequest, changed: () => void): HTMLElement {
  const wrap = h('div');
  const modes = h(
    'div',
    { className: 'modes' },
    ...BODY_MODES.map(([m, label]) => {
      const radio = h('input', { type: 'radio', name: 'bm', checked: r.bodyMode === m });
      radio.addEventListener('change', () => {
        r.bodyMode = m;
        changed();
        renderReqPane();
      });
      return h('label', {}, radio, label);
    }),
  );
  const parts: Child[] = [modes];
  switch (r.bodyMode) {
    case 'none':
      parts.push(h('p', { className: 'muted' }, 'This request does not have a body.'));
      break;
    case 'json':
    case 'text':
    case 'xml': {
      const ta = codeArea(r.body, (v) => {
        r.body = v;
        changed();
      }, 'body', r.bodyMode === 'json' ? '{\n  "key": "{{value}}"\n}' : '');
      const tools = h('div', { className: 'kv-tools' }, h('span', { className: 'muted small' }, r.bodyMode === 'json' ? 'Content-Type: application/json' : r.bodyMode === 'xml' ? 'Content-Type: application/xml' : 'Content-Type: text/plain'));
      if (r.bodyMode === 'json') {
        tools.append(
          h('button', {
            className: 'btn ghost sm',
            textContent: 'Beautify',
            onclick: () => {
              try {
                // Keep {{vars}} that aren't valid JSON: protect them first.
                const marks: string[] = [];
                const safe = r.body.replace(/\{\{[^}]+\}\}/g, (m) => `"__V${marks.push(m) - 1}__"`);
                const pretty = JSON.stringify(JSON.parse(safe), null, 2).replace(/"__V(\d+)__"/g, (_m, i) => marks[Number(i)]);
                r.body = pretty;
                ta.value = pretty;
                changed();
              } catch (e) {
                toast(`Not valid JSON: ${(e as Error).message}`, true);
              }
            },
          }),
        );
      }
      parts.push(tools, ta);
      break;
    }
    case 'form':
      parts.push(kvEditor(r.form, { onChange: changed }));
      break;
    case 'multipart':
      r.multipart ??= [];
      parts.push(kvEditor(r.multipart, { files: true, onChange: changed }));
      break;
    case 'binary': {
      const path = h('span', { className: 'mono' }, r.binaryPath || 'No file chosen');
      parts.push(
        h(
          'div',
          { className: 'kv-tools' },
          path,
          h('button', {
            className: 'btn sm',
            textContent: 'Choose file…',
            onclick: async () => {
              const p = await invoke<string | null>('api:pick-file', { purpose: 'binary' });
              if (p) {
                r.binaryPath = p;
                path.textContent = p;
                changed();
              }
            },
          }),
        ),
        h('p', { className: 'note' }, 'The file is read from this machine when you send (it is not copied into the collection).'),
      );
      break;
    }
    case 'graphql': {
      r.graphql ??= { query: '', variables: '' };
      const g = r.graphql;
      parts.push(
        h(
          'div',
          { style: 'display:grid; grid-template-columns: 1.4fr 1fr; gap: 10px' },
          h('div', {}, h('div', { className: 'muted small' }, 'Query'), codeArea(g.query, (v) => { g.query = v; changed(); }, 'body', 'query {\n  user(id: "1") { name }\n}')),
          h('div', {}, h('div', { className: 'muted small' }, 'GraphQL variables (JSON)'), codeArea(g.variables, (v) => { g.variables = v; changed(); }, 'body', '{ "id": "1" }')),
        ),
      );
      break;
    }
  }
  wrap.append(...parts.filter((p): p is Node => p instanceof Node));
  return wrap;
}

function settingsEditor(r: SavedRequest, changed: () => void): HTMLElement {
  const s = (r.settings ??= {});
  const eff = { ...DEFAULT_SETTINGS, ...s };
  const num = (value: number, min: number, max: number, set: (n: number) => void) => {
    const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max) });
    i.addEventListener('change', () => {
      const n = Math.min(max, Math.max(min, Math.round(Number(i.value) || 0)));
      i.value = String(n);
      set(n);
      changed();
    });
    return i;
  };
  const proxyHint = !state.proxy.available
    ? 'The Proxy plugin is not in this build.'
    : state.proxy.running
      ? 'The Proxy is running: this request will show in its HTTP history (and can be intercepted).'
      : 'Start the Proxy (Proxy mode) for this to take effect; until then requests go direct.';
  return h(
    'div',
    {},
    switchRow('Use the browser’s cookies', 'Send this site’s cookies from the browser and store the cookies it sets — so a site you are signed into in a tab is signed in here too.', checkbox(eff.useBrowserCookies, (v) => { s.useBrowserCookies = v; changed(); })),
    switchRow('Follow redirects', 'Follow 3xx responses automatically (the chain is shown with the response).', checkbox(eff.followRedirects, (v) => { s.followRedirects = v; changed(); })),
    switchRow('Maximum redirects', 'Stop following after this many.', num(eff.maxRedirects, 0, 50, (n) => (s.maxRedirects = n))),
    switchRow('SSL certificate verification', 'Turn off for self-signed / internal certificates (corporate TLS inspection).', checkbox(eff.verifyTls, (v) => { s.verifyTls = v; changed(); })),
    switchRow('Request timeout (ms)', 'Give up after this long.', num(eff.timeoutMs, 100, 600_000, (n) => (s.timeoutMs = n))),
    switchRow('Send through the Proxy', proxyHint, checkbox(eff.viaProxy, (v) => { s.viaProxy = v; changed(); }, !state.proxy.available)),
  );
}

document.querySelectorAll<HTMLButtonElement>('#rtabs button').forEach((b) =>
  b.addEventListener('click', () => {
    cur().reqTab = b.dataset.rt as ReqTab;
    renderReqPane();
    persistTabs();
  }),
);

methodEl.addEventListener('change', () => {
  cur().req.method = methodEl.value;
  methodEl.className = `ap-method mono m-${methodEl.value}`;
  touched();
});
urlEl.addEventListener('input', () => {
  const t = cur();
  urlFromInput(t.req, urlEl.value);
  if (t.reqTab === 'params') renderReqPane();
  touched();
});
urlEl.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text') ?? '';
  if (!looksLikeCurl(text)) return;
  const parsed = parseCurl(text);
  if (!parsed) return;
  e.preventDefault();
  const t = cur();
  t.req = { ...parsed, id: t.req.id, name: t.req.name === 'New request' || !t.req.name ? parsed.name : t.req.name };
  loadTab();
  touched();
  toast('cURL command imported');
});
urlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void send();
});
nameEl.addEventListener('input', () => {
  cur().req.name = nameEl.value;
  touched();
});

// ============================================================================
// Tabs
// ============================================================================
const tabsEl = $('tabs');

function openTab(req: SavedRequest, where: { collectionId?: string; folderId?: string } = {}, opts: { fresh?: boolean } = {}): OpenTab {
  if (req.id && !opts.fresh) {
    const existing = tabs.find((t) => t.req.id === req.id);
    if (existing) {
      activate(existing.key);
      return existing;
    }
  }
  const r = normalizeRequest(clone(req), genId);
  if (!req.id) r.id = '';
  const t: OpenTab = { key: genId(), req: r, ...where, saved: req.id ? JSON.stringify(r) : '', reqTab: 'params', resTab: 'body', bodyView: 'pretty' };
  tabs.push(t);
  activate(t.key);
  return t;
}

function activate(key: string): void {
  activeKey = key;
  loadTab();
  renderTabs();
  renderSide();
  persistTabs();
}

function closeTab(key: string): void {
  const t = tabs.find((x) => x.key === key);
  if (!t) return;
  if (isDirty(t) && (t.req.id || t.req.url) && !confirm(`Close “${t.req.name}” without saving your changes?`)) return;
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (!tabs.length) openTab(newRequest());
  else if (activeKey === key) activate(tabs[Math.min(i, tabs.length - 1)].key);
  else renderTabs();
  persistTabs();
}

function renderTabs(): void {
  tabsEl.replaceChildren(
    ...tabs.map((t) => {
      const el = h(
        'div',
        { className: 'ap-tab' + (t.key === activeKey ? ' active' : ''), title: `${t.req.method} ${t.req.url || '(no URL)'}` },
        h('span', { className: `m m-${t.req.method}`, textContent: t.req.method }),
        h('span', { className: 'name', textContent: t.req.name || 'Untitled' }),
        isDirty(t) && (t.req.id || t.req.url) ? h('span', { className: 'dirty', title: 'Unsaved changes' }) : null,
        h('button', { className: 'x', textContent: '×', title: 'Close', onclick: (e: MouseEvent) => { e.stopPropagation(); closeTab(t.key); } }),
      );
      el.addEventListener('click', () => activate(t.key));
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) closeTab(t.key);
      });
      return el;
    }),
  );
}

/** Reflect the active tab into the URL bar, name, editors and response. */
function loadTab(): void {
  const t = cur();
  if (!t) return;
  methodEl.value = t.req.method;
  methodEl.className = `ap-method mono m-${t.req.method}`;
  urlEl.value = urlDisplay(t.req);
  nameEl.value = t.req.name;
  $('crumbs').textContent = crumbsOf(t);
  $<HTMLButtonElement>('btn-send').textContent = t.sending ? 'Sending…' : 'Send';
  $<HTMLButtonElement>('btn-send').disabled = !!t.sending;
  renderReqPane();
  renderResponse();
}

function crumbsOf(t: OpenTab): string {
  const loc = t.req.id ? findRequest(state.collections, t.req.id) : null;
  if (loc) return [loc.collection.name, ...loc.folders.map((f) => f.name)].join(' / ') + ' /';
  const col = state.collections.find((c) => c.id === t.collectionId);
  return col ? `${col.name} / (unsaved)` : 'Unsaved request';
}

$('btn-newtab').addEventListener('click', () => openTab(newRequest()));

/** Open tabs survive a reload of the panel (per-machine convenience). */
let persistTimer = 0;
function persistTabs(): void {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    try {
      const data = { activeKey, tabs: tabs.map(({ key, req, collectionId, folderId, saved, reqTab }) => ({ key, req, collectionId, folderId, saved, reqTab })) };
      localStorage.setItem('api-client.tabs', JSON.stringify(data));
    } catch {
      /* storage unavailable — tabs just won't be restored */
    }
  }, 300);
}
function restoreTabs(): boolean {
  try {
    const raw = localStorage.getItem('api-client.tabs');
    if (!raw) return false;
    const data = JSON.parse(raw) as { activeKey: string; tabs: Partial<OpenTab>[] };
    tabs = data.tabs
      .filter((t) => t.req && t.key)
      .map((t) => ({ resTab: 'body', bodyView: 'pretty', reqTab: 'params', saved: '', ...t, req: normalizeRequest(t.req!, genId) }) as OpenTab);
    // An id normalizeRequest just invented means the tab was never saved.
    for (const t of data.tabs) if (t.req && !t.req.id) tabs.find((x) => x.key === t.key)!.req.id = '';
    activeKey = tabs.some((t) => t.key === data.activeKey) ? data.activeKey : tabs[0]?.key ?? '';
    return tabs.length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Send
// ============================================================================
async function send(): Promise<void> {
  const t = cur();
  if (!t || t.sending) return;
  if (!t.req.url.trim()) {
    toast('Enter a URL first', true);
    urlEl.focus();
    return;
  }
  t.sending = true;
  loadTabButtons(t);
  if (t.result?.exchange?.response) t.prevBody = prettyForDiff(b64ToText(t.result.exchange.response.body.b64));
  renderResponse();
  try {
    const res = await invoke<RunResult>('api:run', { request: t.req, collectionId: t.collectionId, folderId: t.folderId });
    t.result = res;
    if (res.error && !res.exchange) t.resTab = res.console.length ? 'console' : 'body';
    else if (res.tests.some((x) => !x.passed)) t.resTab = 'tests';
    else if (t.resTab === 'diff' || t.resTab === 'sent') t.resTab = 'body';
    if (res.varsChanged) await reloadState();
    if (side === 'history') void loadHistory();
  } catch (e) {
    t.result = { tests: [], console: [], error: String(e), varsChanged: false };
  } finally {
    t.sending = false;
    if (t.key === activeKey) {
      loadTabButtons(t);
      renderResponse();
    }
  }
}
function loadTabButtons(t: OpenTab): void {
  if (t.key !== activeKey) return;
  const b = $<HTMLButtonElement>('btn-send');
  b.textContent = t.sending ? 'Sending…' : 'Send';
  b.disabled = !!t.sending;
}
$('btn-send').addEventListener('click', () => void send());

// ============================================================================
// Response viewer
// ============================================================================
const resPane = $('res-pane');

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64ToText(b64: string): string {
  return new TextDecoder().decode(b64ToBytes(b64));
}
function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}
const headerOf = (ex: HttpExchange, name: string) => ex.response?.headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? '';

/** JSON → highlighted spans (keys, strings, numbers, booleans, null). Text stays inert. */
function highlightJson(text: string): Node[] {
  const out: Node[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(document.createTextNode(text.slice(last, i)));
    const cls = m[1] ? (m[2] ? 'j-key' : 'j-str') : m[3] ? 'j-bool' : m[4] ? 'j-null' : 'j-num';
    out.push(h('span', { className: cls, textContent: m[1] ?? m[0] }));
    if (m[2]) out.push(document.createTextNode(m[2]));
    last = i + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function renderResponse(): void {
  const t = cur();
  const head = $('res-head');
  const res = t?.result;
  const ex = res?.exchange;
  const r = ex?.response;
  // Tab counters.
  const tests = res?.tests ?? [];
  const failed = tests.filter((x) => !x.passed).length;
  const cookies = r ? r.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').length : 0;
  document.querySelectorAll<HTMLButtonElement>('#restabs button').forEach((b) => {
    const rt = b.dataset.res as ResTab;
    const label = b.dataset.label ?? (b.dataset.label = b.textContent ?? '');
    const count =
      rt === 'headers' && r ? String(r.headers.length) : rt === 'cookies' && cookies ? String(cookies) : rt === 'tests' && tests.length ? `${tests.length - failed}/${tests.length}` : rt === 'console' && res?.console.length ? String(res.console.length) : '';
    b.replaceChildren(label, count ? h('span', { className: 'count' + (rt === 'tests' && failed ? ' bad' : '') }, count) : '');
    b.classList.toggle('active', rt === t?.resTab);
  });

  if (!t) return;
  if (t.sending) {
    head.replaceChildren(h('span', { className: 'ap-meta' }, 'Sending request…'));
    resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, 'Waiting for the response…'));
    return;
  }
  if (!res) {
    head.replaceChildren(h('span', { className: 'ap-meta' }, 'Response'));
    resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, 'Enter a URL and press Send (Ctrl+Enter) to get a response.', h('br'), 'Paste a cURL command into the URL bar to import it.'));
    return;
  }

  // Head: status · time · size · actions.
  const parts: Child[] = [];
  if (r) {
    parts.push(
      h('span', { className: `ap-status s${String(r.status)[0]}` }, `${r.status} ${r.statusText}`),
      h('span', { className: 'ap-meta', title: r.ttfbMs != null ? `Time to first byte ${r.ttfbMs} ms` : '' }, `${r.timingMs} ms`),
      h('span', { className: 'ap-meta' }, fmtBytes(b64ToBytes(r.body.b64).length + (r.body.truncatedBytes ?? 0))),
    );
    if (res.redirects?.length) parts.push(h('span', { className: 'ap-meta', title: res.redirects.map((x) => `${x.status} → ${x.url}`).join('\n') }, `${res.redirects.length} redirect${res.redirects.length > 1 ? 's' : ''}`));
    if (tests.length) parts.push(h('span', { className: failed ? 'ap-meta bad' : 'ap-meta ok' }, failed ? `${failed} test${failed > 1 ? 's' : ''} failed` : 'All tests passed'));
  }
  if (res.error) parts.push(h('span', { className: 'ap-status err' }, 'Error'), h('span', { className: 'ap-meta bad' }, res.error));
  parts.push(h('span', { className: 'grow' }));
  if (r && t.resTab === 'body') {
    for (const v of ['pretty', 'raw', 'preview'] as const) {
      parts.push(h('button', { className: 'btn sm' + (t.bodyView === v ? ' primary' : ' ghost'), textContent: v[0].toUpperCase() + v.slice(1), onclick: () => { t.bodyView = v; renderResponse(); } }));
    }
  }
  if (r) {
    parts.push(
      h('button', { className: 'btn sm ghost', textContent: 'Copy', title: 'Copy the response body', onclick: () => void navigator.clipboard.writeText(b64ToText(r.body.b64)).then(() => toast('Copied')) }),
      h('button', {
        className: 'btn sm ghost',
        textContent: 'Save…',
        title: 'Save the response body to a file',
        onclick: async () => {
          const ext = (headerOf(ex!, 'content-type').match(/json|xml|html|csv|pdf|png|jpe?g|gif|zip/)?.[0] ?? 'txt').replace('jpeg', 'jpg');
          const p = await invoke<string | null>('api:save-response', { b64: r.body.b64, name: `${t.req.name || 'response'}.${ext}` });
          if (p) toast(`Saved to ${p}`);
        },
      }),
    );
    if (/^https?:/i.test(ex!.request.url) && ex!.request.method === 'GET') {
      parts.push(h('button', { className: 'btn sm ghost', textContent: 'Open in tab', title: 'Open this URL in a browser tab (shares cookies)', onclick: () => bro.plugin.send('api:open-tab', ex!.request.url) }));
    }
  }
  head.replaceChildren(...parts.filter((p): p is Node => p instanceof Node));

  // Pane.
  const pre = (text: string, cls = 'ap-out') => h('pre', { className: cls, textContent: text });
  switch (t.resTab) {
    case 'body': {
      if (!r) {
        resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, res.error ?? 'No response.'));
        break;
      }
      const ct = headerOf(ex!, 'content-type').toLowerCase();
      const bytes = b64ToBytes(r.body.b64);
      const trunc = r.body.truncatedBytes ? h('div', { className: 'note' }, `Showing the first ${fmtBytes(bytes.length)} — ${fmtBytes(r.body.truncatedBytes)} more were not kept (10 MB cap). Use Save… on a smaller response or a direct download.`) : null;
      if (t.bodyView === 'preview') {
        if (ct.startsWith('image/')) {
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ct.split(';')[0] }));
          resPane.replaceChildren(h('img', { className: 'ap-img', src: url, alt: 'Response image' }));
        } else if (ct.includes('html') || /^\s*</.test(b64ToText(r.body.b64).slice(0, 200))) {
          // sandbox="" — no scripts, no forms, no same-origin: the page is only drawn.
          const frame = h('iframe', { className: 'ap-preview', title: 'HTML preview' });
          frame.setAttribute('sandbox', '');
          frame.srcdoc = b64ToText(r.body.b64);
          resPane.replaceChildren(frame);
        } else {
          resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, 'No preview for this content type — use Pretty or Raw.'));
        }
        break;
      }
      if (ct.startsWith('image/') || ct.includes('octet-stream') || ct.includes('pdf') || ct.includes('zip')) {
        resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, `Binary response (${ct || 'unknown type'}, ${fmtBytes(bytes.length)}). Use Preview for images, or Save… to keep it.`));
        break;
      }
      const text = b64ToText(r.body.b64);
      if (t.bodyView === 'pretty') {
        let pretty: string | null = null;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* not JSON */
        }
        if (pretty !== null) {
          const out = h('pre', { className: 'ap-out' });
          if (pretty.length < 1_500_000) out.append(...highlightJson(pretty));
          else out.textContent = pretty;
          resPane.replaceChildren(...nodes(trunc, out));
          break;
        }
        if (ct.includes('xml') || ct.includes('html')) {
          resPane.replaceChildren(...nodes(trunc, pre(prettyXml(text))));
          break;
        }
      }
      resPane.replaceChildren(...nodes(trunc, pre(text)));
      break;
    }
    case 'headers':
      resPane.replaceChildren(r ? h('table', { className: 'htable' }, h('tbody', {}, ...r.headers.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { className: 'mono' }, v))))) : h('div', { className: 'ap-placeholder' }, 'No response.'));
      break;
    case 'cookies': {
      const list = r ? r.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v) : [];
      resPane.replaceChildren(
        list.length
          ? h(
              'div',
              {},
              h('table', { className: 'htable' }, h('tbody', {}, ...list.map((v) => {
                const [pair, ...attrs] = v.split(';');
                const eq = pair.indexOf('=');
                return h('tr', {}, h('td', {}, pair.slice(0, eq)), h('td', { className: 'mono' }, pair.slice(eq + 1), h('div', { className: 'muted small' }, attrs.join(';').trim())));
              }))),
              h('p', { className: 'note', style: 'margin:10px 12px' }, 'With “Use the browser’s cookies” on, these were stored in the browser’s cookie jar — your tabs see them too. Manage them with Cookies (top right).'),
            )
          : h('div', { className: 'ap-placeholder' }, 'The response set no cookies.'),
      );
      break;
    }
    case 'tests':
      resPane.replaceChildren(
        tests.length
          ? h(
              'div',
              {},
              h('div', { className: 'tests-sum' }, h('span', { className: 'ok' }, `${tests.length - failed} passed`), h('span', { className: failed ? 'bad' : 'muted' }, `${failed} failed`)),
              ...tests.map((x) => h('div', { className: 'test' }, h('span', { className: `badge ${x.passed ? 'pass' : 'fail'}` }, x.passed ? 'PASS' : 'FAIL'), h('div', {}, x.name, x.error ? h('div', { className: 'err' }, x.error) : null))),
            )
          : h('div', { className: 'ap-placeholder' }, 'No tests ran. Write some in the Tests tab, e.g. ', h('code', {}, 'pm.test("ok", () => pm.response.to.have.status(200))')),
      );
      break;
    case 'console':
      resPane.replaceChildren(
        res.console.length
          ? h('div', {}, ...res.console.map((c) => h('div', { className: `cline ${c.level}` }, h('span', { className: 'from' }, c.from), c.text)))
          : h('div', { className: 'ap-placeholder' }, 'Nothing logged. console.log(…) in a script prints here.'),
      );
      break;
    case 'sent': {
      if (!ex) {
        resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, 'Nothing was sent.'));
        break;
      }
      const q = ex.request;
      const body = q.body?.text ?? (q.body?.b64 ? `(${fmtBytes(b64ToBytes(q.body.b64).length)} binary / multipart body)` : '');
      const redirects = res.redirects?.length ? `\n\n# Redirects followed\n${res.redirects.map((x) => `${x.status} → ${x.url}`).join('\n')}` : '';
      resPane.replaceChildren(pre(`${q.method} ${q.url}\n${q.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}${body ? `\n\n${body}` : ''}${redirects}`));
      break;
    }
    case 'diff': {
      if (!r) {
        resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, 'No response.'));
        break;
      }
      if (t.prevBody === undefined) {
        resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, 'Send again to compare this response with the next one.'));
        break;
      }
      const now = prettyForDiff(b64ToText(r.body.b64));
      if (now.split('\n').length > 4000 || t.prevBody.split('\n').length > 4000) {
        resPane.replaceChildren(h('div', { className: 'ap-placeholder' }, 'Responses too large to diff here (over 4000 lines).'));
        break;
      }
      const lines = diffLines(t.prevBody, now);
      const changes = lines.filter((l) => l.type !== 'same').length;
      resPane.replaceChildren(
        h('div', { className: 'tests-sum' }, h('span', { className: changes ? 'warn' : 'ok' }, changes ? `${changes} line${changes > 1 ? 's' : ''} changed since the previous send` : 'Identical to the previous send')),
        h('div', { className: 'ap-out' }, ...lines.map((l) => h('div', { className: `dl ${l.type}` }, (l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  ') + l.text))),
      );
      break;
    }
  }
}

function prettyXml(xml: string): string {
  if (xml.length > 1_000_000) return xml;
  let depth = 0;
  return xml
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + line;
      if (/^<[^!?/][^>]*[^/]>(?!.*<\/)/.test(line)) depth++;
      return out;
    })
    .join('\n');
}

document.querySelectorAll<HTMLButtonElement>('#restabs button').forEach((b) =>
  b.addEventListener('click', () => {
    cur().resTab = b.dataset.res as ResTab;
    renderResponse();
  }),
);

// Drag the divider to resize request vs response.
{
  const div = $('divider');
  const pane = reqPane;
  div.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = pane.getBoundingClientRect().height;
    const move = (ev: MouseEvent) => {
      pane.style.flex = 'none';
      pane.style.height = `${Math.max(80, Math.min(innerHeight - 260, startH + ev.clientY - startY))}px`;
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

// ============================================================================
// Saving
// ============================================================================
async function saveCollection(c: Collection): Promise<Collection> {
  const saved = await invoke<Collection>('api:save-collection', c);
  const i = state.collections.findIndex((x) => x.id === saved.id);
  if (i >= 0) state.collections[i] = saved;
  else state.collections.push(saved);
  return saved;
}

/** Folder list of a collection as "A / B" paths for selects. */
function folderPaths(col: Collection): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  const walk = (fs: Folder[], prefix: string) => {
    for (const f of fs) {
      const p = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ id: f.id ?? '', path: p });
      walk(f.folders ?? [], p);
    }
  };
  walk(col.folders, '');
  return out;
}

function containerOf(col: Collection, folderId?: string): { requests: SavedRequest[] } {
  if (!folderId) return col;
  return findFolder(col, folderId)?.folder ?? col;
}

async function save(t = cur(), saveAs = false): Promise<void> {
  const loc = t.req.id && !saveAs ? findRequest(state.collections, t.req.id) : null;
  if (loc) {
    const col = clone(loc.collection);
    const fresh = findRequest([col], t.req.id)!;
    const list = fresh.folders.length ? fresh.folders[fresh.folders.length - 1].requests : col.requests;
    list[list.findIndex((r) => r.id === t.req.id)] = clone(t.req);
    await saveCollection(col);
    t.saved = JSON.stringify(t.req);
    touched();
    renderSide();
    toast('Saved');
    return;
  }
  saveDialog(t);
}

function saveDialog(t: OpenTab): void {
  const name = h('input', { type: 'text', value: t.req.name || 'New request', style: 'width:100%' });
  const colSel = h('select', { style: 'width:100%' });
  const folderSel = h('select', { style: 'width:100%' });
  const newCol = h('input', { type: 'text', placeholder: 'New collection name', value: 'My Collection', style: 'width:100%' });
  const fill = () => {
    colSel.replaceChildren(...state.collections.map((c) => h('option', { value: c.id, textContent: c.name })), h('option', { value: '__new', textContent: '+ New collection…' }));
    colSel.value = t.collectionId && state.collections.some((c) => c.id === t.collectionId) ? t.collectionId : state.collections[0]?.id ?? '__new';
    fillFolders();
  };
  const fillFolders = () => {
    const col = state.collections.find((c) => c.id === colSel.value);
    newCol.parentElement!.hidden = colSel.value !== '__new';
    folderSel.replaceChildren(h('option', { value: '', textContent: '(top level)' }), ...(col ? folderPaths(col).map((f) => h('option', { value: f.id, textContent: f.path })) : []));
    folderSel.value = col && t.folderId && folderPaths(col).some((f) => f.id === t.folderId) ? t.folderId : '';
  };
  colSel.addEventListener('change', fillFolders);
  const body = h(
    'div',
    { className: 'form-grid' },
    h('label', {}, 'Request name'),
    name,
    h('label', {}, 'Collection'),
    colSel,
    h('label', {}, ''),
    h('div', {}, newCol),
    h('label', {}, 'Folder'),
    folderSel,
  );
  modal('Save request', body, [
    h('button', { className: 'btn', textContent: 'Cancel', onclick: closeModal }),
    h('button', {
      className: 'btn primary',
      textContent: 'Save',
      onclick: async () => {
        let col = state.collections.find((c) => c.id === colSel.value);
        if (!col) col = await saveCollection({ ...newCollection(newCol.value.trim() || 'My Collection') });
        col = clone(col);
        const req = clone(t.req);
        req.id = genId();
        req.name = name.value.trim() || 'New request';
        containerOf(col, folderSel.value || undefined).requests.push(req);
        await saveCollection(col);
        t.req = req;
        t.collectionId = col.id;
        t.folderId = folderSel.value || undefined;
        t.saved = JSON.stringify(req);
        closeModal();
        expanded.add(col.id);
        if (folderSel.value) expanded.add(folderSel.value);
        loadTab();
        touched();
        renderSide();
        toast('Saved');
      },
    }),
  ]);
  fill();
  name.focus();
  name.select();
}

$('btn-save').addEventListener('click', () => void save());

// ============================================================================
// Sidebar
// ============================================================================
const sideList = $('side-list');
const filterEl = $<HTMLInputElement>('side-filter');

document.querySelectorAll<HTMLButtonElement>('.ap-side-tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    side = b.dataset.side as typeof side;
    document.querySelectorAll('.ap-side-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    if (side === 'history') void loadHistory();
    renderSide();
  }),
);
filterEl.addEventListener('input', () => renderSide());

function renderSide(): void {
  if (side === 'collections') renderCollections();
  else if (side === 'environments') renderEnvironments();
  else renderHistory();
}

function matches(text: string): boolean {
  const q = filterEl.value.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

function node(opts: { depth: number; caret?: boolean; open?: boolean; icon?: Child; label: string; cls?: string; active?: boolean; title?: string; onClick: () => void; onMore?: (btn: HTMLElement) => void; onDbl?: () => void }): HTMLElement {
  const more = opts.onMore ? h('button', { className: 'more', textContent: '⋯', title: 'More actions' }) : null;
  const el = h(
    'div',
    { className: `ap-node ${opts.cls ?? ''}${opts.active ? ' active' : ''}`, title: opts.title ?? opts.label },
    h('span', { className: 'caret', textContent: opts.caret ? (opts.open ? '▾' : '▸') : '' }),
    opts.icon ?? null,
    h('span', { className: 'name', textContent: opts.label }),
    more,
  );
  el.style.paddingLeft = `${6 + opts.depth * 14}px`;
  el.addEventListener('click', (e) => {
    if (more && more.contains(e.target as Node)) return;
    opts.onClick();
  });
  if (opts.onDbl) el.addEventListener('dblclick', opts.onDbl);
  if (more && opts.onMore) {
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onMore!(more);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      opts.onMore!(more);
    });
  }
  return el;
}

function renderCollections(): void {
  const out: HTMLElement[] = [];
  const q = filterEl.value.trim();
  if (!state.collections.length) {
    out.push(
      h(
        'div',
        { className: 'ap-empty' },
        'No collections yet.',
        h('br'),
        'Create one with + New, import a Postman collection / OpenAPI spec with Import, or press Save on a request.',
      ),
    );
  }
  const reqNode = (col: Collection, r: SavedRequest, depth: number, folderId?: string) =>
    node({
      depth,
      icon: h('span', { className: `m m-${r.method}`, textContent: r.method }),
      label: r.name,
      title: `${r.method} ${r.url}`,
      active: cur()?.req.id === r.id,
      onClick: () => openTab(r, { collectionId: col.id, folderId }),
      onMore: (btn) =>
        menu(btn, [
          { label: 'Open in new tab', run: () => openTab(r, { collectionId: col.id, folderId }, { fresh: false }) },
          { label: 'Rename', run: () => renameRequest(col, r) },
          { label: 'Duplicate', run: () => duplicateRequest(col, r, folderId) },
          { label: 'Run (send now)', run: () => { openTab(r, { collectionId: col.id, folderId }); void send(); } },
          { sep: true, label: '' },
          { label: 'Delete', danger: true, run: () => deleteRequest(col, r) },
        ]),
    });
  const folderMatches = (f: Folder): boolean => matches(f.name) || f.requests.some((r) => matches(`${r.name} ${r.url}`)) || (f.folders ?? []).some(folderMatches);
  const walk = (col: Collection, fs: Folder[], depth: number) => {
    for (const f of fs) {
      if (q && !folderMatches(f)) continue;
      const id = f.id ?? '';
      const open = expanded.has(id) || !!q;
      out.push(
        node({
          depth,
          caret: true,
          open,
          icon: h('span', { className: 'ico', textContent: '📁' }),
          label: f.name,
          onClick: () => {
            if (expanded.has(id)) expanded.delete(id);
            else expanded.add(id);
            renderSide();
          },
          onDbl: () => editContainer(col, f),
          onMore: (btn) =>
            menu(btn, [
              { label: 'Add request', run: () => addRequest(col, id) },
              { label: 'Add folder', run: () => addFolder(col, id) },
              { label: 'Edit (auth, scripts)…', run: () => editContainer(col, f) },
              { label: 'Rename', run: () => renameFolder(col, f) },
              { label: 'Run folder…', run: () => runnerDialog(col.id, id) },
              { sep: true, label: '' },
              { label: 'Delete folder', danger: true, run: () => deleteFolder(col, f) },
            ]),
        }),
      );
      if (open) {
        walk(col, f.folders ?? [], depth + 1);
        for (const r of f.requests) if (!q || matches(`${r.name} ${r.url}`)) out.push(reqNode(col, r, depth + 1, id));
        if (!f.requests.length && !(f.folders ?? []).length) out.push(h('div', { className: 'ap-empty', style: `padding-left:${34 + depth * 14}px` }, 'Empty folder'));
      }
    }
  };
  for (const col of state.collections) {
    const colMatches = matches(col.name) || col.requests.some((r) => matches(`${r.name} ${r.url}`)) || col.folders.some(folderMatches);
    if (q && !colMatches) continue;
    const open = expanded.has(col.id) || !!q;
    out.push(
      node({
        depth: 0,
        caret: true,
        open,
        cls: 'col',
        label: col.name,
        onClick: () => {
          if (expanded.has(col.id)) expanded.delete(col.id);
          else expanded.add(col.id);
          renderSide();
        },
        onDbl: () => editContainer(col),
        onMore: (btn) =>
          menu(btn, [
            { label: 'Add request', run: () => addRequest(col) },
            { label: 'Add folder', run: () => addFolder(col) },
            { label: 'Edit (auth, scripts, variables)…', run: () => editContainer(col) },
            { label: 'Rename', run: () => renameCollection(col) },
            { label: 'Duplicate', run: () => void duplicateCollection(col) },
            { label: 'Run collection…', run: () => runnerDialog(col.id) },
            { label: 'Export (Postman v2.1)…', run: async () => { const p = await invoke<string | null>('api:export-collection', col.id); if (p) toast(`Exported to ${p}`); } },
            { sep: true, label: '' },
            { label: 'Delete collection', danger: true, run: () => void deleteCollection(col) },
          ]),
      }),
    );
    if (open) {
      walk(col, col.folders, 1);
      for (const r of col.requests) if (!q || matches(`${r.name} ${r.url}`)) out.push(reqNode(col, r, 1));
      if (!col.requests.length && !col.folders.length) out.push(h('div', { className: 'ap-empty', style: 'padding-left:34px' }, 'Empty — use ⋯ → Add request'));
    }
  }
  sideList.replaceChildren(...out);
}

// --- Tree actions ---
function ask(title: string, label: string, value: string, onOk: (v: string) => void): void {
  const inp = h('input', { type: 'text', value, style: 'width:100%' });
  const ok = () => {
    const v = inp.value.trim();
    if (!v) return;
    closeModal();
    onOk(v);
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ok();
  });
  modal(title, h('div', { className: 'form-grid' }, h('label', {}, label), inp), [
    h('button', { className: 'btn', textContent: 'Cancel', onclick: closeModal }),
    h('button', { className: 'btn primary', textContent: 'OK', onclick: ok }),
  ]);
  inp.focus();
  inp.select();
}
async function mutate(col: Collection, fn: (c: Collection) => void): Promise<Collection> {
  const c = clone(col);
  fn(c);
  const saved = await saveCollection(c);
  renderSide();
  return saved;
}
function addRequest(col: Collection, folderId?: string): void {
  ask('New request', 'Name', 'New request', async (name) => {
    const r = { ...newRequest(name), id: genId() };
    const saved = await mutate(col, (c) => containerOf(c, folderId).requests.push(r));
    expanded.add(col.id);
    if (folderId) expanded.add(folderId);
    const loc = findRequest([saved], r.id)!;
    openTab(loc.request, { collectionId: col.id, folderId });
  });
}
function addFolder(col: Collection, parentId?: string): void {
  ask('New folder', 'Name', 'New folder', async (name) => {
    const f = { ...newFolder(name), id: genId() };
    await mutate(col, (c) => {
      if (parentId) {
        const p = findFolder(c, parentId)?.folder;
        if (p) (p.folders ??= []).push(f);
      } else c.folders.push(f);
    });
    expanded.add(col.id);
    if (parentId) expanded.add(parentId);
    renderSide();
  });
}
function renameRequest(col: Collection, r: SavedRequest): void {
  ask('Rename request', 'Name', r.name, async (name) => {
    await mutate(col, (c) => (findRequest([c], r.id)!.request.name = name));
    for (const t of tabs) if (t.req.id === r.id) {
      t.req.name = name;
      t.saved = JSON.stringify({ ...JSON.parse(t.saved || '{}'), name });
    }
    loadTab();
    renderTabs();
  });
}
async function duplicateRequest(col: Collection, r: SavedRequest, folderId?: string): Promise<void> {
  const copy = { ...clone(r), id: genId(), name: `${r.name} copy` };
  await mutate(col, (c) => {
    const list = containerOf(c, folderId).requests;
    list.splice(list.findIndex((x) => x.id === r.id) + 1, 0, copy);
  });
}
function deleteRequest(col: Collection, r: SavedRequest): void {
  if (!confirm(`Delete “${r.name}”?`)) return;
  void mutate(col, (c) => {
    const loc = findRequest([c], r.id);
    if (!loc) return;
    const list = loc.folders.length ? loc.folders[loc.folders.length - 1].requests : c.requests;
    list.splice(list.indexOf(loc.request), 1);
  }).then(() => {
    for (const t of tabs) if (t.req.id === r.id) t.req.id = ''; // keep it open, now unsaved
    renderTabs();
  });
}
function renameFolder(col: Collection, f: Folder): void {
  ask('Rename folder', 'Name', f.name, (name) => void mutate(col, (c) => (findFolder(c, f.id ?? '')!.folder.name = name)));
}
function deleteFolder(col: Collection, f: Folder): void {
  if (!confirm(`Delete folder “${f.name}” and everything in it?`)) return;
  void mutate(col, (c) => {
    const hit = findFolder(c, f.id ?? '');
    if (!hit) return;
    const parent = hit.chain.length ? hit.chain[hit.chain.length - 1].folders! : c.folders;
    parent.splice(parent.indexOf(hit.folder), 1);
  });
}
function renameCollection(col: Collection): void {
  ask('Rename collection', 'Name', col.name, (name) => void mutate(col, (c) => (c.name = name)));
}
async function duplicateCollection(col: Collection): Promise<void> {
  const c = clone(col);
  c.id = '';
  c.name = `${col.name} copy`;
  const reid = (f: Folder) => {
    f.id = genId();
    f.requests.forEach((r) => (r.id = genId()));
    (f.folders ?? []).forEach(reid);
  };
  c.requests.forEach((r) => (r.id = genId()));
  c.folders.forEach(reid);
  await saveCollection(c);
  renderSide();
}
async function deleteCollection(col: Collection): Promise<void> {
  if (!confirm(`Delete collection “${col.name}”? Its file is removed.`)) return;
  await invoke('api:delete-collection', col.id);
  state.collections = state.collections.filter((c) => c.id !== col.id);
  for (const t of tabs) if (t.collectionId === col.id || (t.req.id && !findRequest(state.collections, t.req.id))) {
    t.collectionId = undefined;
    t.req.id = '';
  }
  renderSide();
  renderTabs();
}

/** Collection or folder editor: auth, scripts, variables (collection), description. */
function editContainer(col: Collection, folder?: Folder): void {
  const c = clone(col);
  const target: Collection | Folder = folder ? findFolder(c, folder.id ?? '')!.folder : c;
  target.auth ??= { kind: folder ? 'inherit' : 'none' };
  target.scripts ??= { pre: '', test: '' };
  let tab: 'auth' | 'pre' | 'test' | 'vars' | 'desc' = 'auth';
  const pane = h('div');
  const tabsBar = h('div', { className: 'dtabs' });
  const noop = () => {};
  const render = () => {
    const items: [typeof tab, string][] = [['auth', 'Authorization'], ['pre', 'Pre-request Script'], ['test', 'Tests'], ...(!folder ? [['vars', 'Variables'] as [typeof tab, string]] : []), ['desc', 'Description']];
    tabsBar.replaceChildren(...items.map(([id, label]) => h('button', { className: id === tab ? 'active' : '', textContent: label, onclick: () => { tab = id; render(); } })));
    if (tab === 'auth') {
      pane.replaceChildren(
        authEditor(() => target.auth!, (a) => (target.auth = a), {
          allowInherit: !!folder,
          inheritFrom: () => `Uses the auth of ${folder ? 'its parent folder or the collection' : ''}.`,
          collectionId: () => c.id,
          onChange: noop,
        }),
        h('p', { className: 'note' }, `Requests in this ${folder ? 'folder' : 'collection'} whose auth is “Inherit auth from parent” use this.`),
      );
    } else if (tab === 'pre' || tab === 'test') {
      pane.replaceChildren(
        h('p', { className: 'muted small' }, `Runs ${tab === 'pre' ? 'before' : 'after'} every request in this ${folder ? 'folder' : 'collection'} (collection → folders → request).`),
        scriptEditor(tab, target.scripts!, noop),
      );
    } else if (tab === 'vars') {
      c.variables ??= [];
      pane.replaceChildren(
        h('p', { className: 'muted small' }, 'Collection variables travel with the collection (export/import). Use an environment for values that differ per server, and the Vault for secrets.'),
        kvEditor(c.variables, { onChange: noop }),
      );
    } else {
      pane.replaceChildren(codeArea(target.description ?? '', (v) => (target.description = v), 'bulk', 'What is this for? (Markdown is fine)'));
    }
  };
  render();
  modal(folder ? `Folder · ${folder.name}` : `Collection · ${col.name}`, [tabsBar, pane], [
    h('button', { className: 'btn', textContent: 'Cancel', onclick: closeModal }),
    h('button', {
      className: 'btn primary',
      textContent: 'Save',
      onclick: async () => {
        await saveCollection(c);
        closeModal();
        renderSide();
        loadTab();
        toast('Saved');
      },
    }),
  ]);
}

// --- Environments ---
function renderEnvironments(): void {
  const out: HTMLElement[] = [
    node({
      depth: 0,
      icon: h('span', { className: 'ico', textContent: '🌐' }),
      label: 'Globals',
      title: 'Variables available in every collection and environment',
      onClick: () => editGlobals(),
    }),
  ];
  for (const env of state.environments) {
    if (!matches(env.name)) continue;
    const active = env.id === state.activeEnvId;
    out.push(
      node({
        depth: 0,
        icon: h('span', { className: 'ico', textContent: active ? '●' : '○', title: active ? 'Active' : '' }),
        label: env.name,
        active,
        onClick: () => editEnvironment(env),
        onMore: (btn) =>
          menu(btn, [
            { label: active ? 'Deactivate' : 'Set active', run: () => void setActiveEnv(active ? null : env.id) },
            { label: 'Edit…', run: () => editEnvironment(env) },
            { label: 'Duplicate', run: async () => { await invoke('api:save-environment', { ...clone(env), id: '', name: `${env.name} copy` }); await reloadState(); } },
            { label: 'Export (Postman)…', run: async () => { const p = await invoke<string | null>('api:export-environment', env.id); if (p) toast(`Exported to ${p}`); } },
            { sep: true, label: '' },
            { label: 'Delete', danger: true, run: async () => { if (confirm(`Delete environment “${env.name}”?`)) { await invoke('api:delete-environment', env.id); await reloadState(); } } },
          ]),
      }),
    );
  }
  if (!state.environments.length) out.push(h('div', { className: 'ap-empty' }, 'No environments. An environment holds variables like {{baseUrl}} or {{token}} per server (dev / staging / prod). + New → Environment.'));
  sideList.replaceChildren(...out);
}

function editEnvironment(env: Environment): void {
  const e = clone(env);
  const name = h('input', { type: 'text', value: e.name, style: 'width:100%' });
  modal(`Environment · ${env.name}`, [
    h('div', { className: 'form-grid', style: 'margin-bottom:12px' }, h('label', {}, 'Name'), name),
    kvEditor(e.vars, { secrets: true, placeholderKey: 'Variable' }),
    h('p', { className: 'note' }, 'Use as ', h('code', {}, '{{variable}}'), '. 🔒 masks a value on screen; it is still stored in the environment file — for real secrets put ', h('code', {}, '${vault:name}'), ' as the value (Vault, top right).'),
  ], [
    h('button', { className: 'btn', textContent: 'Cancel', onclick: closeModal }),
    h('button', { className: 'btn', textContent: env.id === state.activeEnvId ? 'Active ✓' : 'Set active', onclick: () => void setActiveEnv(env.id).then(closeModal) }),
    h('button', {
      className: 'btn primary',
      textContent: 'Save',
      onclick: async () => {
        e.name = name.value.trim() || e.name;
        await invoke('api:save-environment', e);
        closeModal();
        await reloadState();
        toast('Environment saved');
      },
    }),
  ]);
}

function editGlobals(): void {
  const rows = clone(state.globals);
  modal('Globals', [kvEditor(rows, { secrets: true, placeholderKey: 'Variable' }), h('p', { className: 'note' }, 'Globals are the lowest-precedence scope: collection variables, the active environment, data-file values and pm.variables override them.')], [
    h('button', { className: 'btn', textContent: 'Cancel', onclick: closeModal }),
    h('button', { className: 'btn primary', textContent: 'Save', onclick: async () => { await invoke('api:save-globals', rows); closeModal(); await reloadState(); toast('Globals saved'); } }),
  ]);
}

async function setActiveEnv(id: string | null): Promise<void> {
  await invoke('api:set-active-env', id);
  await reloadState();
}

const envEl = $<HTMLSelectElement>('env');
function renderEnvSelect(): void {
  envEl.replaceChildren(h('option', { value: '', textContent: 'No environment' }), ...state.environments.map((e) => h('option', { value: e.id, textContent: e.name })));
  envEl.value = state.activeEnvId ?? '';
}
envEl.addEventListener('change', () => void setActiveEnv(envEl.value || null));

// --- History ---
async function loadHistory(): Promise<void> {
  history = await invoke<HttpExchange[]>('api:history');
  if (side === 'history') renderHistory();
}

function requestFromExchange(ex: HttpExchange): SavedRequest {
  const r = newRequest();
  r.method = ex.request.method;
  const u = ex.request.url;
  const qi = u.indexOf('?');
  r.url = qi >= 0 ? u.slice(0, qi) : u;
  if (qi >= 0) {
    r.params = u.slice(qi + 1).split('&').filter(Boolean).map((p) => {
      const eq = p.indexOf('=');
      const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
      return { key: dec(eq >= 0 ? p.slice(0, eq) : p), value: dec(eq >= 0 ? p.slice(eq + 1) : ''), on: true };
    });
  }
  // The browser jar adds cookies by itself — don't freeze them into the request.
  r.headers = ex.request.headers.filter(([k]) => k.toLowerCase() !== 'cookie').map(([key, value]) => ({ key, value, on: true }));
  const b = ex.request.body;
  if (b?.text != null) {
    const ct = ex.request.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    r.bodyMode = ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : 'text';
    r.body = b.text;
    if (r.bodyMode === 'json') r.headers = r.headers.filter((h) => h.key.toLowerCase() !== 'content-type');
  }
  r.auth = { kind: 'none' };
  try {
    r.name = `${r.method} ${new URL(u).pathname}`;
  } catch {
    r.name = `${r.method} ${u}`;
  }
  return r;
}

function renderHistory(): void {
  const out: HTMLElement[] = [];
  if (!history.length) out.push(h('div', { className: 'ap-empty' }, 'No requests sent yet.'));
  else
    out.push(
      h('div', { style: 'display:flex; justify-content:flex-end; padding:2px 4px' }, h('button', { className: 'btn ghost sm', textContent: 'Clear all', onclick: async () => { if (confirm('Clear the whole history?')) { await invoke('api:history-clear'); await loadHistory(); } } })),
    );
  let day = '';
  for (const ex of history) {
    if (!matches(`${ex.request.method} ${ex.request.url} ${ex.meta.notes ?? ''}`)) continue;
    const d = new Date(ex.meta.startedAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    if (d !== day) {
      day = d;
      out.push(h('div', { className: 'ap-day' }, d));
    }
    const st = ex.response?.status ?? 0;
    out.push(
      node({
        depth: 0,
        icon: h('span', { className: `m m-${ex.request.method}`, textContent: ex.request.method }),
        label: ex.request.url.replace(/^https?:\/\//, ''),
        title: `${st || '—'} · ${new Date(ex.meta.startedAt).toLocaleTimeString()} · ${ex.request.url}`,
        onClick: () => {
          const t = openTab(requestFromExchange(ex), {}, { fresh: true });
          t.result = { exchange: ex, tests: [], console: [], varsChanged: false };
          renderResponse();
        },
        onMore: (btn) =>
          menu(btn, [
            { label: 'Open', run: () => { const t = openTab(requestFromExchange(ex), {}, { fresh: true }); t.result = { exchange: ex, tests: [], console: [], varsChanged: false }; renderResponse(); } },
            { label: 'Save to collection…', run: () => saveDialog(openTab(requestFromExchange(ex), {}, { fresh: true })) },
            { label: 'Copy URL', run: () => void navigator.clipboard.writeText(ex.request.url) },
            { sep: true, label: '' },
            { label: 'Delete', danger: true, run: async () => { await invoke('api:history-delete', ex.id); await loadHistory(); } },
          ]),
      }),
    );
    const last = out[out.length - 1];
    last.append(h('span', { className: `small ${st && st < 400 ? 'ok' : 'bad'}`, textContent: st ? String(st) : 'ERR' }));
  }
  sideList.replaceChildren(...out);
}

// ============================================================================
// Top-level buttons: New, Import, Runner, Code, Vars, Cookies, Vault
// ============================================================================
$('btn-new').addEventListener('click', (e) =>
  menu(e.currentTarget as HTMLElement, [
    { label: 'HTTP request', run: () => openTab(newRequest()) },
    { label: 'Collection', run: () => ask('New collection', 'Name', 'New collection', async (name) => { const c = await saveCollection(newCollection(name)); expanded.add(c.id); side = 'collections'; syncSideTabs(); renderSide(); }) },
    { label: 'Environment', run: () => ask('New environment', 'Name', 'New environment', async (name) => { const env = await invoke<Environment>('api:save-environment', { id: '', name, vars: [{ key: 'baseUrl', value: '', on: true }] }); await setActiveEnv(env.id); side = 'environments'; syncSideTabs(); renderSide(); editEnvironment(env); }) },
  ]),
);
function syncSideTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.ap-side-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.side === side));
}

$('btn-import').addEventListener('click', () => {
  const ta = h('textarea', { className: 'bulk mono', placeholder: 'Paste a Postman collection / environment (JSON), an OpenAPI or Swagger spec (JSON or YAML), or a cURL command', spellcheck: false });
  const done = async (sum: { collections: string[]; environments: string[]; request?: SavedRequest; error?: string } | null) => {
    if (!sum) return;
    closeModal();
    await reloadState();
    const msg = [sum.collections.length ? `Collection${sum.collections.length > 1 ? 's' : ''}: ${sum.collections.join(', ')}` : '', sum.environments.length ? `Environment${sum.environments.length > 1 ? 's' : ''}: ${sum.environments.join(', ')}` : '', sum.request ? 'Opened the cURL request in a new tab' : ''].filter(Boolean).join('\n');
    if (sum.request) openTab({ ...sum.request, id: '' });
    if (sum.error) toast(`${msg ? `${msg}\n` : ''}${sum.error}`, true);
    else if (msg) toast(`Imported — ${msg}`);
    else toast('Nothing was imported', true);
    if (sum.collections.length) {
      side = 'collections';
      syncSideTabs();
      renderSide();
    }
  };
  modal('Import', [
    h('p', { className: 'muted' }, 'Postman Collection v2.0 / v2.1, Postman environments, OpenAPI 3 / Swagger 2 (JSON or YAML) and cURL.'),
    h('button', { className: 'btn primary', textContent: 'Choose files…', onclick: async () => done(await invoke('api:import-file')) }),
    h('div', { className: 'muted small', style: 'margin:14px 0 6px' }, '…or paste:'),
    ta,
  ], [
    h('button', { className: 'btn', textContent: 'Cancel', onclick: closeModal }),
    h('button', { className: 'btn primary', textContent: 'Import pasted text', onclick: async () => { if (ta.value.trim()) await done(await invoke('api:import-text', { text: ta.value })); } }),
  ]);
});

$('btn-code').addEventListener('click', async () => {
  const t = cur();
  const req = await invoke<HttpRequest>('api:resolve', { request: t.req, collectionId: t.collectionId, folderId: t.folderId });
  let lang: SnippetLang = 'curl';
  try {
    lang = (localStorage.getItem('api-client.lang') as SnippetLang) || 'curl';
  } catch {
    /* default */
  }
  const sel = h('select', {}, ...SNIPPET_LANGS.map((l) => h('option', { value: l.id, textContent: l.label })));
  sel.value = lang;
  const out = h('pre', { className: 'snippet' });
  const render = () => {
    out.textContent = snippet(sel.value as SnippetLang, req);
    try {
      localStorage.setItem('api-client.lang', sel.value);
    } catch {
      /* fine */
    }
  };
  sel.addEventListener('change', render);
  render();
  modal('Code snippet', [
    h('div', { className: 'kv-tools' }, sel, h('span', { className: 'muted small' }, 'Variables resolved with the active environment. Pre-request scripts are not run; secrets stay as ${vault:…} references.')),
    out,
  ], [
    h('button', { className: 'btn', textContent: 'Close', onclick: closeModal }),
    h('button', { className: 'btn primary', textContent: 'Copy', onclick: () => void navigator.clipboard.writeText(out.textContent ?? '').then(() => toast('Snippet copied')) }),
  ]);
});

$('btn-envlook').addEventListener('click', () => {
  const t = cur();
  const loc = t.req.id ? findRequest(state.collections, t.req.id) : null;
  const col = loc?.collection ?? state.collections.find((c) => c.id === t.collectionId);
  const env = state.environments.find((e) => e.id === state.activeEnvId);
  const scopes: [string, Record<string, string>, Set<string>][] = [
    ['Globals', scopeOf(state.globals), new Set(state.globals.filter((g) => g.secret).map((g) => g.key))],
    [col ? `Collection “${col.name}”` : 'Collection (none)', scopeOf(col?.variables), new Set()],
    [env ? `Environment “${env.name}”` : 'Environment (none active)', scopeOf(env?.vars), new Set(env?.vars.filter((v) => v.secret).map((v) => v.key))],
  ];
  const effective: Record<string, string> = Object.assign({}, ...scopes.map((s) => s[1]));
  modal('Variables in scope', [
    h('p', { className: 'muted small' }, 'Later scopes win (globals < collection < environment < data file < pm.variables). Dynamic variables like {{$guid}} make a new value on every use.'),
    ...scopes.map(([label, vars, secret]) =>
      h('div', {}, h('div', { className: 'cookie-dom' }, label),
        Object.keys(vars).length
          ? h('table', { className: 'htable' }, h('tbody', {}, ...Object.entries(vars).map(([k, v]) => h('tr', {}, h('td', { className: effective[k] === v ? '' : 'muted', title: effective[k] === v ? '' : 'Overridden by a later scope' }, k), h('td', { className: 'mono' }, secret.has(k) ? '••••••' : v)))))
          : h('div', { className: 'muted small' }, 'No variables')),
    ),
    h('div', {}, h('div', { className: 'cookie-dom' }, 'Vault secrets'), state.vaultKeys.length ? h('div', { className: 'mono small' }, state.vaultKeys.map((k) => `\${vault:${k}}`).join('   ')) : h('div', { className: 'muted small' }, 'None')),
  ], [h('button', { className: 'btn', textContent: 'Close', onclick: closeModal })]);
});

$('btn-vault').addEventListener('click', () => vaultDialog());
function vaultDialog(): void {
  const name = h('input', { type: 'text', placeholder: 'name, e.g. prod/token', spellcheck: false });
  const value = h('input', { type: 'password', placeholder: 'secret value' });
  const list = h('div');
  const render = () =>
    list.replaceChildren(
      ...(state.vaultKeys.length
        ? state.vaultKeys.map((k) =>
            h('div', { className: 'switch-row' }, h('span', { className: 'mono' }, `\${vault:${k}}`), h('span', {},
              h('button', { className: 'btn sm ghost', textContent: 'Copy reference', onclick: () => void navigator.clipboard.writeText(`\${vault:${k}}`).then(() => toast('Reference copied')) }),
              h('button', { className: 'btn sm danger', textContent: 'Delete', onclick: async () => { if (confirm(`Delete secret “${k}”?`)) { state.vaultKeys = await invoke<string[]>('api:vault-delete', k); render(); } } }))),
          )
        : [h('p', { className: 'muted' }, 'No secrets yet.')]),
    );
  render();
  modal('Vault', [
    h('p', { className: 'note' }, 'Secrets are encrypted with your OS account (Windows DPAPI / macOS Keychain) and only decrypted when a request is sent. Reference one anywhere — URL, header, auth, body, an environment value — as ', h('code', {}, '${vault:name}'), '. ', h('code', {}, '${env:NAME}'), ' reads an environment variable of this computer. Values can never be read back here.'),
    list,
    h('div', { className: 'kv-tools', style: 'margin-top:12px' }, name, value, h('button', {
      className: 'btn primary',
      textContent: 'Add / replace',
      onclick: async () => {
        try {
          state.vaultKeys = await invoke<string[]>('api:vault-set', { name: name.value.trim(), value: value.value });
          name.value = '';
          value.value = '';
          render();
          toast('Secret stored');
        } catch (e) {
          toast(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
        }
      },
    })),
  ], [h('button', { className: 'btn', textContent: 'Close', onclick: closeModal })]);
}

$('btn-cookies').addEventListener('click', () => cookiesDialog());
interface CookieRow { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expires?: number }
function cookiesDialog(): void {
  const t = cur();
  let host = '';
  try {
    host = new URL(t.result?.exchange?.request.url ?? '').hostname;
  } catch {
    /* none */
  }
  const dom = h('input', { type: 'search', placeholder: 'Domain (empty = all)', value: host, spellcheck: false });
  const list = h('div');
  const load = async () => {
    const rows = await invoke<CookieRow[]>('api:cookies-list', { domain: dom.value.trim() || undefined });
    const byDomain = new Map<string, CookieRow[]>();
    for (const c of rows) byDomain.set(c.domain, [...(byDomain.get(c.domain) ?? []), c]);
    list.replaceChildren(
      ...(rows.length
        ? [...byDomain.entries()].sort().map(([d, cs]) =>
            h('div', {},
              h('div', { className: 'cookie-dom' }, d, h('span', { className: 'muted small' }, `${cs.length}`), h('span', { className: 'grow' }), h('button', { className: 'btn sm ghost danger', textContent: 'Clear domain', onclick: async () => { await invoke('api:cookies-clear', d); await load(); } })),
              h('table', { className: 'htable' }, h('tbody', {}, ...cs.map((c) => h('tr', {},
                h('td', {}, c.name),
                h('td', { className: 'mono' }, c.value.length > 120 ? `${c.value.slice(0, 120)}…` : c.value, h('div', { className: 'muted small' }, [c.path, c.secure ? 'Secure' : '', c.httpOnly ? 'HttpOnly' : '', c.expires ? `expires ${new Date(c.expires * 1000).toLocaleString()}` : 'session'].filter(Boolean).join(' · '))),
                h('td', { style: 'width:30px' }, h('button', { className: 'btn sm ghost', textContent: '✕', title: 'Delete cookie', onclick: async () => { await invoke('api:cookie-delete', c); await load(); } })),
              )))),
            ),
          )
        : [h('p', { className: 'muted' }, dom.value.trim() ? `No cookies for ${dom.value.trim()}.` : 'The cookie jar is empty.')]),
    );
  };
  dom.addEventListener('input', () => void load());
  modal('Cookies', [h('p', { className: 'muted small' }, 'This is the browser’s own cookie jar (default profile) — the same cookies your tabs use. Requests with “Use the browser’s cookies” on send and store these.'), dom, list], [h('button', { className: 'btn', textContent: 'Close', onclick: closeModal })]);
  void load();
}

// ============================================================================
// Collection runner
// ============================================================================
$('btn-runner').addEventListener('click', () => runnerDialog());
let runUnsub: (() => void) | null = null;

function runnerDialog(collectionId?: string, folderId?: string): void {
  if (!state.collections.length) {
    toast('Create or import a collection first', true);
    return;
  }
  const colSel = h('select', {}, ...state.collections.map((c) => h('option', { value: c.id, textContent: c.name })));
  colSel.value = collectionId ?? state.collections[0].id;
  const folderSel = h('select');
  const fillFolders = () => {
    const col = state.collections.find((c) => c.id === colSel.value)!;
    folderSel.replaceChildren(h('option', { value: '', textContent: '(whole collection)' }), ...folderPaths(col).map((f) => h('option', { value: f.id, textContent: f.path })));
    folderSel.value = folderId && folderPaths(col).some((f) => f.id === folderId) ? folderId : '';
  };
  colSel.addEventListener('change', fillFolders);
  fillFolders();
  const iters = h('input', { type: 'number', value: '1', min: '1', max: '1000' });
  const delay = h('input', { type: 'number', value: '0', min: '0', max: '60000' });
  const stop = h('input', { type: 'checkbox' });
  let data: Record<string, string>[] | undefined;
  const dataLabel = h('span', { className: 'muted small' }, 'No data file');
  const env = state.environments.find((e) => e.id === state.activeEnvId);
  const steps = h('div', { className: 'run-steps', hidden: true });
  const summary = h('div', { className: 'tests-sum' });
  let runId = '';
  const runBtn = h('button', { className: 'btn primary', textContent: 'Run' });
  const stopBtn = h('button', { className: 'btn danger', textContent: 'Stop', hidden: true });

  const show = (s: RunnerSummary) => {
    if (s.runId !== runId) return;
    steps.hidden = false;
    steps.replaceChildren(
      ...s.steps.map((st) =>
        h('div', { className: 'run-step' },
          h('div', { className: 'line' },
            h('span', { className: 'muted small', style: 'width:42px' }, `#${st.iteration + 1}`),
            h('span', { className: `m m-${st.method}`, textContent: st.method }),
            h('span', { className: 'grow' }, st.name, h('span', { className: 'muted small' }, `  ${st.url}`)),
            st.status ? h('span', { className: st.status < 400 ? 'ok' : 'bad' }, String(st.status)) : h('span', { className: 'bad' }, 'ERR'),
            st.timingMs != null ? h('span', { className: 'muted small' }, `${st.timingMs} ms`) : null,
          ),
          st.error ? h('div', { className: 't bad' }, st.error) : null,
          ...st.tests.map((tt) => h('div', { className: 't' }, h('span', { className: `badge ${tt.passed ? 'pass' : 'fail'}` }, tt.passed ? 'PASS' : 'FAIL'), ' ', tt.name, tt.error ? h('span', { className: 'muted' }, ` — ${tt.error}`) : null)),
        ),
      ),
    );
    steps.scrollTop = steps.scrollHeight;
    summary.replaceChildren(
      h('span', {}, `${s.steps.length} request${s.steps.length === 1 ? '' : 's'}`),
      h('span', { className: 'ok' }, `${s.passed} passed`),
      h('span', { className: s.failed ? 'bad' : 'muted' }, `${s.failed} failed`),
      h('span', { className: s.errors ? 'bad' : 'muted' }, `${s.errors} errors`),
      h('span', { className: 'muted' }, `${(s.durationMs / 1000).toFixed(1)} s`),
      s.done ? h('strong', {}, s.stopped ? 'Stopped' : 'Done') : h('span', { className: 'muted' }, 'Running…'),
    );
    if (s.done) {
      runBtn.disabled = false;
      stopBtn.hidden = true;
      void reloadState();
    }
  };
  runUnsub?.();
  runUnsub = bro.plugin.on<RunnerSummary>('api:run-progress', show);

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    stopBtn.hidden = false;
    steps.replaceChildren();
    summary.replaceChildren(h('span', { className: 'muted' }, 'Starting…'));
    runId = await invoke<string>('api:runner-start', {
      collectionId: colSel.value,
      folderId: folderSel.value || undefined,
      iterations: Number(iters.value) || 1,
      delayMs: Number(delay.value) || 0,
      data,
      stopOnFailure: stop.checked,
    });
  });
  stopBtn.addEventListener('click', () => void invoke('api:runner-stop', runId));

  modal('Collection runner', [
    h('div', { className: 'form-grid' },
      h('label', {}, 'Collection'), colSel,
      h('label', {}, 'Folder'), folderSel,
      h('label', {}, 'Environment'), h('span', {}, env ? env.name : 'No environment (change it at the top right)'),
      h('label', {}, 'Iterations'), iters,
      h('label', {}, 'Delay between requests (ms)'), delay,
      h('label', {}, 'Data file'), h('div', { className: 'kv-tools', style: 'margin:0; justify-content:flex-start' },
        h('button', { className: 'btn sm', textContent: 'Choose CSV / JSON…', onclick: async () => {
          const r = await invoke<{ path: string; rows: Record<string, string>[]; error?: string } | null>('api:pick-file', { purpose: 'data' });
          if (!r) return;
          if (r.error) return toast(r.error, true);
          data = r.rows;
          dataLabel.textContent = `${r.path.split(/[\\/]/).pop()} — ${r.rows.length} row${r.rows.length === 1 ? '' : 's'} (one iteration each; use {{column}})`;
        } }),
        dataLabel),
      h('label', {}, 'Stop on first failure'), stop,
    ),
    h('p', { className: 'muted small' }, 'Requests run in order (folders top to bottom). Scripts can change the order with pm.execution.setNextRequest("name") or stop the run with setNextRequest(null). Variable changes are saved to the environment as the run goes.'),
    summary,
    steps,
  ], [stopBtn, h('button', { className: 'btn', textContent: 'Close', onclick: closeModal }), runBtn], () => {
    runUnsub?.();
    runUnsub = null;
  });
}

// ============================================================================
// Keyboard
// ============================================================================
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape' && !$('modal').hidden) {
    closeModal();
    return;
  }
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    void send();
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save(cur(), e.shiftKey);
  }
});

// ============================================================================
// Boot
// ============================================================================
async function reloadState(): Promise<void> {
  state = await invoke<ApiState>('api:state');
  // Tabs whose saved request vanished (deleted elsewhere) become unsaved copies.
  for (const t of tabs) if (t.req.id && !findRequest(state.collections, t.req.id)) t.req.id = '';
  renderEnvSelect();
  renderSide();
  renderTabs();
  if (cur()) $('crumbs').textContent = crumbsOf(cur());
}

bro.plugin.on('api:changed', () => void reloadState().then(() => toast('Collections reloaded (changed on disk)')));

void (async () => {
  await reloadState();
  if (!restoreTabs()) openTab(newRequest());
  else {
    renderTabs();
    loadTab();
  }
  for (const c of state.collections.slice(0, 1)) expanded.add(c.id);
  renderSide();
  void loadHistory();
})();
