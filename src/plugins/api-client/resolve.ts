// Request resolution: SavedRequest (+ its folder chain and collection) → the
// exact HttpRequest that goes on the wire.
//
// Postman's order, kept here:
//   1. a DRAFT request is built with {{variables}} still in place — that is what
//      pre-request scripts see (and may edit) as pm.request;
//   2. after the scripts ran (and maybe changed variables), every {{var}} is
//      substituted, auth is applied (inherited through folders → collection),
//      the body is encoded (JSON / raw / XML / urlencoded / multipart / binary /
//      GraphQL), and finally ${env:NAME} / ${vault:name} secrets are expanded —
//      in main only, never shown in the UI or written to a collection file.
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Auth, Collection, Folder, KeyVal, SavedRequest } from '../../shared/api-model';
import type { Header, HttpRequest } from '../../shared/http-model';
import { substituteVars, type VarScope } from '../../shared/vars';
import type { Vault } from './vault';

/** The draft pre-request scripts see: variables NOT yet substituted. */
export interface Draft {
  method: string;
  url: string;
  headers: Header[];
  body: string;
}

/** Walk inherit → folder (innermost first) → collection. */
export function effectiveAuth(req: SavedRequest, folders: Folder[], col?: Collection): Auth {
  if (req.auth?.kind && req.auth.kind !== 'inherit') return req.auth;
  for (let i = folders.length - 1; i >= 0; i--) {
    const a = folders[i].auth;
    if (a?.kind && a.kind !== 'inherit') return a;
  }
  const c = col?.auth;
  return c?.kind && c.kind !== 'inherit' ? c : { kind: 'none' };
}

const on = (rows: KeyVal[] | undefined) => (rows ?? []).filter((r) => r.on && r.key);
const hasHeader = (hs: Header[], name: string) => hs.some(([k]) => k.toLowerCase() === name.toLowerCase());

function authHeader(auth: Auth): Header | null {
  switch (auth.kind) {
    case 'bearer':
      return auth.token ? ['Authorization', `Bearer ${auth.token}`] : null;
    case 'basic':
      // Encoded after substitution (see finalize) — marked here.
      return ['Authorization', `__BASIC__${auth.username ?? ''}\u0000${auth.password ?? ''}`];
    case 'apikey':
      return auth.in !== 'query' && auth.key ? [auth.key, auth.value ?? ''] : null;
    case 'oauth2': {
      const o = auth.oauth2;
      if (!o?.accessToken) return null;
      const prefix = o.headerPrefix ?? 'Bearer';
      return ['Authorization', prefix ? `${prefix} ${o.accessToken}` : o.accessToken];
    }
    default:
      return null;
  }
}

function queryRows(req: SavedRequest, auth: Auth): KeyVal[] {
  const rows = on(req.params);
  if (auth.kind === 'apikey' && auth.in === 'query' && auth.key) rows.push({ key: auth.key, value: auth.value ?? '', on: true });
  return rows;
}

function rawQuery(rows: KeyVal[]): string {
  return rows.map((r) => `${r.key}=${r.value}`).join('&');
}

function draftBody(req: SavedRequest): string {
  switch (req.bodyMode) {
    case 'json':
    case 'text':
    case 'xml':
      return req.body ?? '';
    case 'form':
      return on(req.form).map((f) => `${f.key}=${f.value}`).join('&');
    case 'graphql':
      return graphqlJson(req.graphql?.query ?? '', req.graphql?.variables ?? '');
    default:
      return ''; // multipart / binary are encoded at the end
  }
}

function graphqlJson(query: string, variables: string): string {
  let vars: unknown = undefined;
  if (variables.trim()) {
    try {
      vars = JSON.parse(variables);
    } catch {
      vars = variables; // left as a string → the server says what's wrong
    }
  }
  return JSON.stringify(vars === undefined ? { query } : { query, variables: vars });
}

const DEFAULT_CT: Partial<Record<SavedRequest['bodyMode'], string>> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  form: 'application/x-www-form-urlencoded',
  graphql: 'application/json',
};

export function makeDraft(req: SavedRequest, auth: Auth): Draft {
  const headers: Header[] = on(req.headers).map((h) => [h.key, h.value]);
  const ah = authHeader(auth);
  if (ah && !hasHeader(headers, ah[0])) headers.push(ah);
  const ct = DEFAULT_CT[req.bodyMode];
  if (ct && !hasHeader(headers, 'content-type')) headers.push(['Content-Type', ct]);
  const q = rawQuery(queryRows(req, auth));
  const url = q ? `${req.url}${req.url.includes('?') ? '&' : '?'}${q}` : req.url;
  return { method: req.method.toUpperCase(), url, headers, body: draftBody(req) };
}

/**
 * Substitute variables into the (possibly script-edited) draft and encode the
 * body. Parts the scripts did not touch are rebuilt from the saved rows so each
 * value is URL-encoded AFTER substitution (a var holding "a&b" stays one value).
 */
export async function finalize(req: SavedRequest, auth: Auth, original: Draft, draft: Draft, vars: VarScope): Promise<HttpRequest> {
  const sub = (s: string) => substituteVars(s, vars);

  // URL + query.
  let url: string;
  if (draft.url === original.url) {
    const base = sub(req.url).trim();
    const q = queryRows(req, auth)
      .map((r) => `${encodeURIComponent(sub(r.key))}=${encodeURIComponent(sub(r.value))}`)
      .join('&');
    url = q ? `${base}${base.includes('?') ? '&' : '?'}${q}` : base;
  } else {
    url = sub(draft.url).trim();
  }
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`; // Postman's default

  // Headers (Basic auth is encoded after its parts are substituted).
  let headers: Header[] = draft.headers.map(([k, v]) => {
    if (v.startsWith('__BASIC__')) {
      const [u, p] = v.slice('__BASIC__'.length).split('\u0000');
      return [sub(k), `Basic ${Buffer.from(`${sub(u)}:${sub(p ?? '')}`).toString('base64')}`];
    }
    return [sub(k), sub(v)];
  });

  // Body.
  let body: HttpRequest['body'];
  const touched = draft.body !== original.body;
  if (touched) {
    body = draft.body ? { kind: 'text', text: sub(draft.body) } : undefined;
  } else {
    switch (req.bodyMode) {
      case 'json':
      case 'graphql':
        body = { kind: 'json', text: sub(draft.body) };
        break;
      case 'text':
      case 'xml':
        body = { kind: 'text', text: sub(draft.body) };
        break;
      case 'form':
        body = {
          kind: 'form',
          text: on(req.form).map((f) => `${encodeURIComponent(sub(f.key))}=${encodeURIComponent(sub(f.value))}`).join('&'),
        };
        break;
      case 'multipart': {
        const { buf, boundary } = await multipart(on(req.multipart), sub);
        headers = headers.filter(([k]) => k.toLowerCase() !== 'content-type');
        headers.push(['Content-Type', `multipart/form-data; boundary=${boundary}`]);
        body = { kind: 'binary', b64: buf.toString('base64') };
        break;
      }
      case 'binary': {
        if (req.binaryPath) {
          const buf = await fs.readFile(req.binaryPath);
          if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/octet-stream']);
          body = { kind: 'binary', b64: buf.toString('base64') };
        }
        break;
      }
      default:
        body = undefined;
    }
  }
  // A HEAD request never carries a body, whatever the editor holds (a GET may — e.g. Elasticsearch).
  if (draft.method === 'HEAD') body = undefined;

  return { method: draft.method, url, headers, body };
}

async function multipart(rows: KeyVal[], sub: (s: string) => string): Promise<{ buf: Buffer; boundary: string }> {
  const boundary = `----BroPlusFormBoundary${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const r of rows) {
    const name = sub(r.key).replace(/"/g, '%22');
    if (r.type === 'file') {
      const path = sub(r.value);
      const data = await fs.readFile(path);
      const file = basename(path).replace(/"/g, '%22');
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${file}"\r\nContent-Type: ${mimeOf(file)}\r\n\r\n`),
        data,
        Buffer.from('\r\n'),
      );
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${sub(r.value)}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { buf: Buffer.concat(parts), boundary };
}

function mimeOf(file: string): string {
  const ext = file.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    json: 'application/json', txt: 'text/plain', csv: 'text/csv', xml: 'application/xml', html: 'text/html',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
  };
  return map[ext] ?? 'application/octet-stream';
}

const SECRET_RE = /\$\{(vault|env):([^}]+)\}/g;

/** Expand ${env:NAME} and ${vault:name} in URL, headers and text bodies (main only). */
export async function expandSecrets(r: HttpRequest, vault: Vault): Promise<{ req: HttpRequest; missing: string[] }> {
  const missing: string[] = [];
  const names = new Set<string>();
  const scan = (s?: string) => {
    for (const m of (s ?? '').matchAll(SECRET_RE)) names.add(`${m[1]}:${m[2]}`);
  };
  scan(r.url);
  for (const [k, v] of r.headers) {
    scan(k);
    scan(v);
  }
  scan(r.body?.text);
  if (!names.size) return { req: r, missing };

  const values = new Map<string, string>();
  for (const n of names) {
    const [kind, name] = [n.slice(0, n.indexOf(':')), n.slice(n.indexOf(':') + 1)];
    const v = kind === 'env' ? process.env[name] : await vault.get(name);
    if (v === undefined) missing.push(n);
    else values.set(n, v);
  }
  const exp = (s: string) => s.replace(SECRET_RE, (w, kind: string, name: string) => values.get(`${kind}:${name}`) ?? w);
  return {
    missing,
    req: {
      ...r,
      url: exp(r.url),
      headers: r.headers.map(([k, v]) => [exp(k), exp(v)] as Header),
      body: r.body?.text != null ? { ...r.body, text: exp(r.body.text) } : r.body,
    },
  };
}

