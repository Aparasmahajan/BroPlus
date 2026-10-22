// Import / export: Postman Collection v2.0/v2.1, Postman environments, OpenAPI 3
// / Swagger 2 (JSON or YAML), cURL, and runner data files (CSV / JSON).
// Main process only (file access goes through native dialogs in main.ts).
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import {
  emptyAuth,
  emptyOAuth2,
  newCollection,
  newFolder,
  newRequest,
  normalizeCollection,
  type Auth,
  type Collection,
  type Environment,
  type Folder,
  type KeyVal,
  type SavedRequest,
  type Scripts,
} from '../../shared/api-model';
import { looksLikeCurl, parseCurl } from '../../shared/curl';

export type Imported =
  | { kind: 'collection'; collection: Collection }
  | { kind: 'environment'; environment: Environment }
  | { kind: 'request'; request: SavedRequest };

/** Figure out what a file / pasted text is and convert it. */
export function importText(text: string, fileName = ''): Imported {
  const t = text.trim();
  if (looksLikeCurl(t)) {
    const r = parseCurl(t);
    if (r) return { kind: 'request', request: { ...r, id: randomUUID() } };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(t);
  } catch {
    try {
      doc = YAML.parse(t);
    } catch {
      throw new Error('Not JSON, YAML or a cURL command');
    }
  }
  const o = doc as Record<string, unknown>;
  if (!o || typeof o !== 'object') throw new Error('Nothing to import');
  if (o.openapi || o.swagger) return { kind: 'collection', collection: fromOpenApi(o) };
  if (o.info && Array.isArray(o.item)) return { kind: 'collection', collection: fromPostman(o) };
  if (o.collection && typeof o.collection === 'object') return importText(JSON.stringify(o.collection), fileName); // API export wrapper
  if (Array.isArray(o.values) && typeof o.name === 'string') return { kind: 'environment', environment: fromPostmanEnv(o) };
  if (o.name && Array.isArray(o.folders) && Array.isArray(o.requests)) {
    return { kind: 'collection', collection: normalizeCollection({ ...(o as unknown as Collection), id: '' }, randomUUID) };
  }
  throw new Error('Unrecognised format — expected a Postman collection/environment, OpenAPI/Swagger, or cURL');
}

// --- Postman → Bro Plus ----------------------------------------------------------

type PmKV = { key?: string; value?: unknown; disabled?: boolean; enabled?: boolean; type?: string; src?: unknown; description?: unknown };
type PmAuthParam = { key: string; value?: unknown };
type PmAuth = { type?: string } & Record<string, PmAuthParam[] | string | undefined>;
type PmEvent = { listen?: string; script?: { exec?: string[] | string } };
type PmItem = {
  name?: string;
  item?: PmItem[];
  request?: unknown;
  event?: PmEvent[];
  auth?: PmAuth;
  description?: unknown;
};

const str = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const desc = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && 'content' in v ? str((v as { content: unknown }).content) : undefined);
const kv = (rows: PmKV[] | undefined): KeyVal[] =>
  (rows ?? []).filter((r) => r && r.key != null).map((r) => ({ key: str(r.key), value: str(r.value), on: !r.disabled && r.enabled !== false }));

function pmAuth(a: PmAuth | undefined, fallback: Auth['kind']): Auth {
  if (!a?.type) return emptyAuth(fallback);
  const p = (name: string): string => {
    const list = a[a.type!] as PmAuthParam[] | undefined;
    return Array.isArray(list) ? str(list.find((x) => x.key === name)?.value) : '';
  };
  switch (a.type) {
    case 'noauth':
      return emptyAuth('none');
    case 'bearer':
      return { kind: 'bearer', token: p('token') };
    case 'basic':
      return { kind: 'basic', username: p('username'), password: p('password') };
    case 'apikey':
      return { kind: 'apikey', key: p('key'), value: p('value'), in: p('in') === 'query' ? 'query' : 'header' };
    case 'oauth2':
      return {
        kind: 'oauth2',
        oauth2: {
          ...emptyOAuth2(),
          grant: p('grant_type') === 'password_credentials' ? 'password' : 'client_credentials',
          tokenUrl: p('accessTokenUrl'),
          clientId: p('clientId'),
          clientSecret: p('clientSecret'),
          scope: p('scope'),
          username: p('username'),
          password: p('password'),
          clientAuth: p('client_authentication') === 'body' ? 'body' : 'basic',
          accessToken: p('accessToken'),
          headerPrefix: p('headerPrefix') || 'Bearer',
        },
      };
    default:
      // Digest, AWS, Hawk, NTLM… not supported: keep the request, flag it.
      return emptyAuth('none');
  }
}

function pmScripts(ev: PmEvent[] | undefined): Scripts {
  const get = (listen: string) => {
    const e = (ev ?? []).find((x) => x.listen === listen);
    const exec = e?.script?.exec;
    return Array.isArray(exec) ? exec.join('\n') : str(exec);
  };
  return { pre: get('prerequest'), test: get('test') };
}

function pmRequest(item: PmItem): SavedRequest {
  const r = newRequest(item.name || 'Request');
  r.id = randomUUID();
  r.scripts = pmScripts(item.event);
  const raw = item.request;
  if (typeof raw === 'string') {
    r.url = raw;
    return r;
  }
  const q = (raw ?? {}) as {
    method?: string;
    header?: PmKV[] | string;
    url?: string | { raw?: string; query?: PmKV[] };
    body?: {
      mode?: string;
      raw?: string;
      options?: { raw?: { language?: string } };
      urlencoded?: PmKV[];
      formdata?: PmKV[];
      file?: { src?: string };
      graphql?: { query?: string; variables?: string };
      disabled?: boolean;
    };
    auth?: PmAuth;
    description?: unknown;
  };
  r.method = (q.method || 'GET').toUpperCase();
  r.headers = Array.isArray(q.header) ? kv(q.header) : [];
  r.auth = pmAuth(q.auth, 'inherit');
  r.description = desc(q.description) ?? desc(item.description);

  // URL: Postman keeps the query both in `raw` and in `query` — use the rows.
  const u = q.url;
  if (typeof u === 'string') {
    const i = u.indexOf('?');
    r.url = i >= 0 ? u.slice(0, i) : u;
    if (i >= 0) r.params = splitQuery(u.slice(i + 1));
  } else if (u) {
    const rawUrl = u.raw ?? '';
    const i = rawUrl.indexOf('?');
    r.url = i >= 0 ? rawUrl.slice(0, i) : rawUrl;
    r.params = Array.isArray(u.query) ? kv(u.query) : i >= 0 ? splitQuery(rawUrl.slice(i + 1)) : [];
  }

  const b = q.body;
  if (b && !b.disabled) {
    switch (b.mode) {
      case 'raw': {
        const lang = b.options?.raw?.language ?? '';
        r.bodyMode = lang === 'json' ? 'json' : lang === 'xml' ? 'xml' : /^\s*[[{]/.test(b.raw ?? '') ? 'json' : 'text';
        r.body = b.raw ?? '';
        break;
      }
      case 'urlencoded':
        r.bodyMode = 'form';
        r.form = kv(b.urlencoded);
        break;
      case 'formdata':
        r.bodyMode = 'multipart';
        r.multipart = (b.formdata ?? []).map((f) => ({
          key: str(f.key),
          value: f.type === 'file' ? str(Array.isArray(f.src) ? f.src[0] : f.src) : str(f.value),
          on: !f.disabled,
          type: f.type === 'file' ? 'file' : 'text',
        }));
        break;
      case 'file':
        r.bodyMode = 'binary';
        r.binaryPath = str(b.file?.src) || undefined;
        break;
      case 'graphql':
        r.bodyMode = 'graphql';
        r.graphql = { query: str(b.graphql?.query), variables: str(b.graphql?.variables) };
        break;
    }
  }
  return r;
}

function splitQuery(q: string): KeyVal[] {
  return q
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf('=');
      return { key: eq >= 0 ? p.slice(0, eq) : p, value: eq >= 0 ? p.slice(eq + 1) : '', on: true };
    });
}

function pmItems(items: PmItem[], into: { folders: Folder[]; requests: SavedRequest[] }): void {
  for (const it of items) {
    if (Array.isArray(it.item)) {
      const f = newFolder(it.name || 'Folder');
      f.id = randomUUID();
      f.auth = pmAuth(it.auth, 'inherit');
      f.scripts = pmScripts(it.event);
      f.description = desc(it.description);
      const sub = { folders: f.folders ?? [], requests: f.requests };
      pmItems(it.item, sub);
      f.folders = sub.folders;
      into.folders.push(f);
    } else {
      into.requests.push(pmRequest(it));
    }
  }
}

export function fromPostman(o: Record<string, unknown>): Collection {
  const info = (o.info ?? {}) as { name?: string; description?: unknown };
  const c = newCollection(info.name || 'Imported collection');
  c.id = randomUUID();
  c.description = desc(info.description);
  c.auth = pmAuth(o.auth as PmAuth | undefined, 'none');
  c.scripts = pmScripts(o.event as PmEvent[] | undefined);
  c.variables = kv(o.variable as PmKV[] | undefined);
  pmItems(o.item as PmItem[], c);
  return normalizeCollection(c, randomUUID);
}

export function fromPostmanEnv(o: Record<string, unknown>): Environment {
  const values = (o.values ?? []) as PmKV[];
  return {
    id: randomUUID(),
    name: str(o.name) || 'Imported environment',
    vars: values.map((v) => ({ key: str(v.key), value: str(v.value), on: v.enabled !== false && !v.disabled, secret: v.type === 'secret' || undefined })),
  };
}

// --- OpenAPI 3 / Swagger 2 → collection -------------------------------------------

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; example?: unknown; default?: unknown; enum?: unknown[]; $ref?: string; format?: string; allOf?: Schema[]; oneOf?: Schema[]; anyOf?: Schema[] };
type Param = { name: string; in: string; example?: unknown; schema?: Schema; required?: boolean; description?: string; $ref?: string };

export function fromOpenApi(doc: Record<string, unknown>): Collection {
  const info = (doc.info ?? {}) as { title?: string; description?: string };
  const c = newCollection(info.title || 'OpenAPI import');
  c.id = randomUUID();
  c.description = info.description;

  const ref = <T>(x: T & { $ref?: string }): T => {
    let cur: unknown = x;
    for (let hops = 0; hops < 10 && cur && typeof cur === 'object' && '$ref' in (cur as object); hops++) {
      const path = String((cur as { $ref: string }).$ref).replace(/^#\//, '').split('/');
      cur = path.reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
    }
    return (cur ?? {}) as T;
  };
  const sample = (s: Schema | undefined, depth = 0): unknown => {
    if (!s || depth > 6) return null;
    s = ref(s);
    if (s.example !== undefined) return s.example;
    if (s.default !== undefined) return s.default;
    if (s.enum?.length) return s.enum[0];
    const all = s.allOf ?? s.oneOf ?? s.anyOf;
    if (all?.length) {
      const parts = all.map((x) => sample(x, depth + 1));
      return parts.every((p) => p && typeof p === 'object' && !Array.isArray(p)) ? Object.assign({}, ...parts) : parts[0];
    }
    switch (s.type) {
      case 'object':
      case undefined:
        if (!s.properties) return s.type ? {} : null;
        return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, sample(v, depth + 1)]));
      case 'array':
        return [sample(s.items, depth + 1)];
      case 'integer':
      case 'number':
        return 0;
      case 'boolean':
        return true;
      default:
        return s.format === 'date-time' ? new Date(0).toISOString() : s.format === 'uuid' ? '00000000-0000-0000-0000-000000000000' : 'string';
    }
  };

  // Base URL → a collection variable, like Postman does.
  let base = '';
  if (Array.isArray(doc.servers) && doc.servers[0]) base = String((doc.servers[0] as { url?: string }).url ?? '');
  else if (doc.host) base = `${(doc.schemes as string[] | undefined)?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}`;
  c.variables = [{ key: 'baseUrl', value: base.replace(/\/$/, ''), on: true }];

  // Security → collection auth.
  const comps = (doc.components ?? {}) as { securitySchemes?: Record<string, { type?: string; scheme?: string; in?: string; name?: string }> };
  const schemes = comps.securitySchemes ?? (doc.securityDefinitions as typeof comps.securitySchemes) ?? {};
  const first = Object.values(schemes)[0];
  if (first) {
    if ((first.type === 'http' && first.scheme === 'bearer') || first.type === 'oauth2' || first.type === 'openIdConnect') {
      c.auth = { kind: 'bearer', token: '{{token}}' };
      c.variables.push({ key: 'token', value: '', on: true });
    } else if (first.type === 'http' && first.scheme === 'basic') c.auth = { kind: 'basic', username: '{{username}}', password: '{{password}}' };
    else if (first.type === 'basic') c.auth = { kind: 'basic', username: '{{username}}', password: '{{password}}' };
    else if (first.type === 'apiKey') {
      c.auth = { kind: 'apikey', key: first.name ?? 'X-API-Key', value: '{{apiKey}}', in: first.in === 'query' ? 'query' : 'header' };
      c.variables.push({ key: 'apiKey', value: '', on: true });
    }
  }

  const byTag = new Map<string, Folder>();
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [path, ops] of Object.entries(paths)) {
    const shared = ((ops.parameters as Param[] | undefined) ?? []).map((p) => ref(p));
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = ops[method] as
        | { summary?: string; operationId?: string; description?: string; tags?: string[]; parameters?: Param[]; requestBody?: unknown; consumes?: string[] }
        | undefined;
      if (!op) continue;
      const r = newRequest(op.summary || op.operationId || `${method.toUpperCase()} ${path}`);
      r.id = randomUUID();
      r.method = method.toUpperCase();
      r.url = `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, '{{$1}}')}`;
      r.description = op.description;
      const params = [...shared, ...(op.parameters ?? []).map((p) => ref(p))];
      for (const p of params) {
        const ex = p.example ?? p.schema?.example ?? p.schema?.default;
        const row = { key: p.name, value: ex === undefined ? '' : str(ex), on: !!p.required || ex !== undefined, description: p.description };
        if (p.in === 'query') r.params.push(row);
        else if (p.in === 'header') r.headers.push(row);
        else if (p.in === 'body' && p.schema) {
          r.bodyMode = 'json';
          r.body = JSON.stringify(sample(p.schema), null, 2);
        }
      }
      const rb = op.requestBody ? ref(op.requestBody as { content?: Record<string, { example?: unknown; schema?: Schema }> }) : undefined;
      const content = (rb as { content?: Record<string, { example?: unknown; schema?: Schema }> } | undefined)?.content;
      if (content) {
        const [ct, media] = Object.entries(content)[0] ?? [];
        if (ct?.includes('json')) {
          r.bodyMode = 'json';
          r.body = JSON.stringify(media?.example ?? sample(media?.schema), null, 2);
        } else if (ct?.includes('x-www-form-urlencoded') || ct?.includes('multipart')) {
          const props = ref(media?.schema ?? {}).properties ?? {};
          const rows = Object.keys(props).map((k) => ({ key: k, value: '', on: true, type: 'text' as const }));
          if (ct.includes('multipart')) {
            r.bodyMode = 'multipart';
            r.multipart = rows;
          } else {
            r.bodyMode = 'form';
            r.form = rows;
          }
        } else if (ct?.includes('xml')) {
          r.bodyMode = 'xml';
        } else if (ct) {
          r.bodyMode = 'text';
        }
      }
      const tag = op.tags?.[0];
      if (tag) {
        let f = byTag.get(tag);
        if (!f) {
          f = { ...newFolder(tag), id: randomUUID() };
          byTag.set(tag, f);
          c.folders.push(f);
        }
        f.requests.push(r);
      } else {
        c.requests.push(r);
      }
    }
  }
  return normalizeCollection(c, randomUUID);
}

// --- Bro Plus → Postman v2.1 ----------------------------------------------------------

const SCHEMA_21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function toPmAuth(a: Auth | undefined): unknown {
  if (!a || a.kind === 'inherit') return undefined;
  const list = (o: Record<string, string | undefined>) => Object.entries(o).map(([key, value]) => ({ key, value: value ?? '', type: 'string' }));
  switch (a.kind) {
    case 'none':
      return { type: 'noauth' };
    case 'bearer':
      return { type: 'bearer', bearer: list({ token: a.token }) };
    case 'basic':
      return { type: 'basic', basic: list({ username: a.username, password: a.password }) };
    case 'apikey':
      return { type: 'apikey', apikey: list({ key: a.key, value: a.value, in: a.in ?? 'header' }) };
    case 'oauth2': {
      const o = a.oauth2 ?? emptyOAuth2();
      return {
        type: 'oauth2',
        oauth2: list({
          grant_type: o.grant === 'password' ? 'password_credentials' : 'client_credentials',
          accessTokenUrl: o.tokenUrl,
          clientId: o.clientId,
          clientSecret: o.clientSecret,
          scope: o.scope,
          username: o.username,
          password: o.password,
          client_authentication: o.clientAuth === 'body' ? 'body' : 'header',
          accessToken: o.accessToken,
          headerPrefix: o.headerPrefix,
          addTokenTo: 'header',
        }),
      };
    }
  }
}

function toPmEvents(s: Scripts | undefined): unknown {
  const ev: unknown[] = [];
  if (s?.pre?.trim()) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: s.pre.split('\n') } });
  if (s?.test?.trim()) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: s.test.split('\n') } });
  return ev.length ? ev : undefined;
}

const toPmKV = (rows: KeyVal[] | undefined) => (rows ?? []).map((r) => ({ key: r.key, value: r.value, ...(r.on ? {} : { disabled: true }) }));

function toPmRequest(r: SavedRequest): unknown {
  const query = toPmKV(r.params);
  const raw = query.length ? `${r.url}?${r.params.filter((p) => p.on).map((p) => `${p.key}=${p.value}`).join('&')}` : r.url;
  let body: unknown;
  switch (r.bodyMode) {
    case 'json':
    case 'text':
    case 'xml':
      body = { mode: 'raw', raw: r.body, options: { raw: { language: r.bodyMode === 'text' ? 'text' : r.bodyMode } } };
      break;
    case 'form':
      body = { mode: 'urlencoded', urlencoded: toPmKV(r.form) };
      break;
    case 'multipart':
      body = {
        mode: 'formdata',
        formdata: (r.multipart ?? []).map((f) => (f.type === 'file' ? { key: f.key, type: 'file', src: f.value, ...(f.on ? {} : { disabled: true }) } : { key: f.key, value: f.value, type: 'text', ...(f.on ? {} : { disabled: true }) })),
      };
      break;
    case 'binary':
      body = { mode: 'file', file: { src: r.binaryPath ?? '' } };
      break;
    case 'graphql':
      body = { mode: 'graphql', graphql: { query: r.graphql?.query ?? '', variables: r.graphql?.variables ?? '' } };
      break;
  }
  return {
    name: r.name,
    event: toPmEvents(r.scripts),
    request: {
      method: r.method,
      header: toPmKV(r.headers),
      url: { raw, ...(query.length ? { query } : {}) },
      ...(body ? { body } : {}),
      ...(r.auth && r.auth.kind !== 'inherit' ? { auth: toPmAuth(r.auth) } : {}),
      ...(r.description ? { description: r.description } : {}),
    },
  };
}

function toPmFolder(f: Folder): unknown {
  return {
    name: f.name,
    item: [...(f.folders ?? []).map(toPmFolder), ...f.requests.map(toPmRequest)],
    auth: toPmAuth(f.auth),
    event: toPmEvents(f.scripts),
    ...(f.description ? { description: f.description } : {}),
  };
}

export function toPostman(c: Collection): string {
  const out = {
    info: { _postman_id: c.id, name: c.name, schema: SCHEMA_21, ...(c.description ? { description: c.description } : {}) },
    item: [...c.folders.map(toPmFolder), ...c.requests.map(toPmRequest)],
    auth: toPmAuth(c.auth),
    event: toPmEvents(c.scripts),
    variable: (c.variables ?? []).map((v) => ({ key: v.key, value: v.value, ...(v.on ? {} : { disabled: true }) })),
  };
  return JSON.stringify(out, null, 2);
}

export function toPostmanEnv(e: Environment): string {
  return JSON.stringify(
    {
      id: e.id,
      name: e.name,
      values: e.vars.map((v) => ({ key: v.key, value: v.value, type: v.secret ? 'secret' : 'default', enabled: v.on })),
      _postman_variable_scope: 'environment',
    },
    null,
    2,
  );
}

// --- Runner data files ------------------------------------------------------------------

/** CSV (RFC 4180, first row = headers) or a JSON array of objects → one row per iteration. */
export function parseDataFile(text: string, name: string): Record<string, string>[] {
  const t = text.replace(/^﻿/, '');
  if (/\.json$/i.test(name) || /^\s*\[/.test(t)) {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr)) throw new Error('A JSON data file must be an array of objects');
    return arr.map((o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, str(v)])));
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}
