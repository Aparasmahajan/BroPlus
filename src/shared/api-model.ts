// Data model for the API client (Postman-class). Collections + environments are
// persisted as portable TOML (store.ts); these are the shapes both the main
// store and the UI share.

export interface KeyVal {
  key: string;
  value: string;
  on: boolean; // enabled row (unchecked = ignored, kept for quick toggling)
}

export type AuthKind = 'none' | 'bearer' | 'basic';

export interface Auth {
  kind: AuthKind;
  token?: string; // bearer
  username?: string; // basic
  password?: string; // basic
}

export type BodyMode = 'none' | 'json' | 'text' | 'form';

export interface SavedRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  params: KeyVal[]; // query params
  headers: KeyVal[];
  auth: Auth;
  bodyMode: BodyMode;
  body: string; // raw text / json; for 'form' it's ignored (params-style rows below)
  form: KeyVal[]; // x-www-form-urlencoded rows
}

export interface Folder {
  name: string;
  requests: SavedRequest[];
}

export interface Collection {
  id: string;
  name: string;
  folders: Folder[];
  requests: SavedRequest[]; // top-level (folder-less) requests
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
}

export function emptyAuth(): Auth {
  return { kind: 'none' };
}

export function newRequest(name = 'New request'): SavedRequest {
  return {
    id: '',
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: emptyAuth(),
    bodyMode: 'none',
    body: '',
    form: [],
  };
}
