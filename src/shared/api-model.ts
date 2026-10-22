// Data model for the API client (Postman-class). Collections + environments are
// persisted as portable TOML (store.ts); these are the shapes the main process
// (resolver, runner, script sandbox, store) and the UI share.
//
// Every field added after v1 is optional or defaulted by `normalize*()`, so
// collection files written by an older build still load.

export interface KeyVal {
  key: string;
  value: string;
  on: boolean; // enabled row (unchecked = ignored, kept for quick toggling)
  /** Environment/global vars: shown masked in the UI (Postman's "secret" type). */
  secret?: boolean;
  /** Multipart rows: a text field, or a file (value = absolute path on this machine). */
  type?: 'text' | 'file';
  description?: string;
}

/** 'inherit' = use the parent folder's / collection's auth (Postman default for requests). */
export type AuthKind = 'inherit' | 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2';

export interface OAuth2 {
  grant: 'client_credentials' | 'password';
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  username: string; // password grant
  password: string; // password grant
  /** Send the client id/secret as HTTP Basic (default) or in the form body. */
  clientAuth: 'basic' | 'body';
  /** The token in use (filled by "Get new access token", or pasted). */
  accessToken: string;
  headerPrefix: string; // usually "Bearer"
}

export interface Auth {
  kind: AuthKind;
  token?: string; // bearer
  username?: string; // basic
  password?: string; // basic
  key?: string; // apikey: header / query name
  value?: string; // apikey: value
  in?: 'header' | 'query'; // apikey placement
  oauth2?: OAuth2;
}

export type BodyMode = 'none' | 'json' | 'text' | 'xml' | 'form' | 'multipart' | 'binary' | 'graphql';

/** Postman-style scripts (run in a QuickJS sandbox — see plugins/api-client/sandbox.ts). */
export interface Scripts {
  pre?: string;
  test?: string;
}

export interface RequestSettings {
  timeoutMs?: number; // default 30 000
  followRedirects?: boolean; // default true
  maxRedirects?: number; // default 10
  verifyTls?: boolean; // default true
  /** Send + store cookies with the BROWSER's cookie jar (default true — the shared-session thesis). */
  useBrowserCookies?: boolean;
  /** Route through the Proxy plugin (when it is running) so the send shows in its history. */
  viaProxy?: boolean;
}

export interface SavedRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  params: KeyVal[]; // query params
  headers: KeyVal[];
  auth: Auth;
  bodyMode: BodyMode;
  body: string; // raw text / json / xml
  form: KeyVal[]; // x-www-form-urlencoded rows
  multipart?: KeyVal[]; // form-data rows (type text | file)
  binaryPath?: string; // binary body: a file on this machine
  graphql?: { query: string; variables: string };
  scripts?: Scripts;
  settings?: RequestSettings;
  description?: string;
}

export interface Folder {
  id?: string;
  name: string;
  folders?: Folder[];
  requests: SavedRequest[];
  auth?: Auth; // default inherit
  scripts?: Scripts;
  description?: string;
}

export interface Collection {
  id: string;
  name: string;
  folders: Folder[];
  requests: SavedRequest[]; // top-level (folder-less) requests
  variables?: KeyVal[];
  auth?: Auth; // default none
  scripts?: Scripts;
  description?: string;
}

export interface Environment {
  id: string;
  name: string;
  vars: KeyVal[];
}

/** Everything the API UI loads at open (api:state). */
export interface ApiState {
  collections: Collection[];
  environments: Environment[];
  activeEnvId: string | null;
  globals: KeyVal[];
  /** Names of the secrets in the vault (values never leave main). */
  vaultKeys: string[];
  /** Is the Proxy plugin in this build (and running)? Drives the "via proxy" switch. */
  proxy: { available: boolean; running: boolean };
}

// --- Results of a send / script run -----------------------------------------

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ConsoleLine {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  /** Which script printed it. */
  from: string;
}

/** What api:run returns for one request (and the runner reports per step). */
export interface RunResult {
  exchange?: import('./http-model').HttpExchange;
  tests: TestResult[];
  console: ConsoleLine[];
  error?: string;
  /** pm.execution.setNextRequest(name) — undefined = not called, null = stop the run. */
  nextRequest?: string | null;
  /** Variables changed by a script (the UI reloads state when true). */
  varsChanged: boolean;
  /** Redirects followed, in order (each hop's status + location). */
  redirects?: { status: number; url: string }[];
}

/** Collection runner options. */
export interface RunnerOptions {
  collectionId: string;
  /** Run only this folder (and its sub-folders); omitted = the whole collection. */
  folderId?: string;
  iterations: number;
  delayMs: number;
  /** One object per iteration (CSV/JSON data file); overrides `iterations` when present. */
  data?: Record<string, string>[];
  stopOnFailure: boolean;
}

export interface RunnerStep {
  iteration: number;
  requestId: string;
  name: string;
  method: string;
  url: string;
  status?: number;
  timingMs?: number;
  tests: TestResult[];
  error?: string;
}

export interface RunnerSummary {
  runId: string;
  done: boolean;
  steps: RunnerStep[];
  passed: number;
  failed: number;
  errors: number;
  durationMs: number;
  stopped?: boolean;
}

// --- Defaults / normalisation ------------------------------------------------

export function emptyAuth(kind: AuthKind = 'none'): Auth {
  return { kind };
}

export function emptyOAuth2(): OAuth2 {
  return {
    grant: 'client_credentials',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: '',
    username: '',
    password: '',
    clientAuth: 'basic',
    accessToken: '',
    headerPrefix: 'Bearer',
  };
}

export const DEFAULT_SETTINGS: Required<RequestSettings> = {
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  verifyTls: true,
  useBrowserCookies: true,
  viaProxy: false,
};

export function newRequest(name = 'New request'): SavedRequest {
  return {
    id: '',
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: emptyAuth('inherit'),
    bodyMode: 'none',
    body: '',
    form: [],
    multipart: [],
    graphql: { query: '', variables: '' },
    scripts: { pre: '', test: '' },
    settings: {},
  };
}

export function newFolder(name = 'New folder'): Folder {
  return { id: '', name, folders: [], requests: [], auth: emptyAuth('inherit'), scripts: { pre: '', test: '' } };
}

export function newCollection(name = 'New collection'): Collection {
  return { id: '', name, folders: [], requests: [], variables: [], auth: emptyAuth('none'), scripts: { pre: '', test: '' } };
}

const arr = <T>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);
const kvs = (x: KeyVal[] | undefined): KeyVal[] =>
  arr(x).map((r) => ({ ...r, key: String(r.key ?? ''), value: String(r.value ?? ''), on: r.on !== false }));

export function normalizeRequest(r: Partial<SavedRequest>, genId: () => string): SavedRequest {
  const base = newRequest(r.name || 'Untitled');
  return {
    ...base,
    ...r,
    id: r.id || genId(),
    method: (r.method || 'GET').toUpperCase(),
    url: r.url ?? '',
    params: kvs(r.params),
    headers: kvs(r.headers),
    form: kvs(r.form),
    multipart: kvs(r.multipart),
    auth: r.auth?.kind ? r.auth : emptyAuth('inherit'),
    bodyMode: r.bodyMode ?? 'none',
    body: r.body ?? '',
    graphql: { query: r.graphql?.query ?? '', variables: r.graphql?.variables ?? '' },
    scripts: { pre: r.scripts?.pre ?? '', test: r.scripts?.test ?? '' },
    settings: { ...(r.settings ?? {}) },
  };
}

export function normalizeFolder(f: Partial<Folder>, genId: () => string): Folder {
  return {
    id: f.id || genId(),
    name: f.name || 'Folder',
    folders: arr(f.folders).map((x) => normalizeFolder(x, genId)),
    requests: arr(f.requests).map((x) => normalizeRequest(x, genId)),
    auth: f.auth?.kind ? f.auth : emptyAuth('inherit'),
    scripts: { pre: f.scripts?.pre ?? '', test: f.scripts?.test ?? '' },
    description: f.description,
  };
}

export function normalizeCollection(c: Partial<Collection>, genId: () => string): Collection {
  return {
    id: c.id || genId(),
    name: c.name || 'Collection',
    folders: arr(c.folders).map((x) => normalizeFolder(x, genId)),
    requests: arr(c.requests).map((x) => normalizeRequest(x, genId)),
    variables: kvs(c.variables),
    auth: c.auth?.kind ? c.auth : emptyAuth('none'),
    scripts: { pre: c.scripts?.pre ?? '', test: c.scripts?.test ?? '' },
    description: c.description,
  };
}

// --- Tree helpers (shared by the runner and the UI) ---------------------------

/** Where a request lives: its collection and the folder chain from the top. */
export interface RequestLocation {
  collection: Collection;
  folders: Folder[];
  request: SavedRequest;
}

export function findRequest(cols: Collection[], requestId: string): RequestLocation | null {
  for (const collection of cols) {
    const hit = (list: SavedRequest[]) => list.find((r) => r.id === requestId);
    const top = hit(collection.requests);
    if (top) return { collection, folders: [], request: top };
    const walk = (fs: Folder[], chain: Folder[]): RequestLocation | null => {
      for (const f of fs) {
        const r = hit(f.requests);
        if (r) return { collection, folders: [...chain, f], request: r };
        const deeper = walk(f.folders ?? [], [...chain, f]);
        if (deeper) return deeper;
      }
      return null;
    };
    const found = walk(collection.folders, []);
    if (found) return found;
  }
  return null;
}

export function findFolder(col: Collection, folderId: string): { folder: Folder; chain: Folder[] } | null {
  const walk = (fs: Folder[], chain: Folder[]): { folder: Folder; chain: Folder[] } | null => {
    for (const f of fs) {
      if (f.id === folderId) return { folder: f, chain };
      const deeper = walk(f.folders ?? [], [...chain, f]);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(col.folders, []);
}

/** Requests in run order (Postman's: a folder's own requests, then its sub-folders… top-level first). */
export function requestsInOrder(col: Collection, folder?: Folder): { request: SavedRequest; folders: Folder[] }[] {
  const out: { request: SavedRequest; folders: Folder[] }[] = [];
  const walk = (f: Folder, chain: Folder[]) => {
    const here = [...chain, f];
    for (const r of f.requests) out.push({ request: r, folders: here });
    for (const sub of f.folders ?? []) walk(sub, here);
  };
  if (folder) {
    const loc = findFolder(col, folder.id ?? '');
    walk(folder, loc?.chain ?? []);
  } else {
    for (const r of col.requests) out.push({ request: r, folders: [] });
    for (const f of col.folders) walk(f, []);
  }
  return out;
}
