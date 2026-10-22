// ApiStore — portable persistence for the API client (ARCHITECTURE.md §5.3),
// mirroring OpsPilot's config-as-source-of-truth: collections, environments and
// globals as human-diffable TOML, atomic writes (temp → rename), hot-reload when
// a file is edited outside the app. History is a JSON ring (derived, not source
// of truth). All under <configDir>/api/.
import TOML from '@iarna/toml';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeCollection,
  type Collection,
  type Environment,
  type KeyVal,
} from '../../shared/api-model';
import type { HttpExchange } from '../../shared/http-model';

const HISTORY_MAX = 200;

/** Drop undefined (TOML can't serialize it) by a JSON round-trip. `any` so it
 *  satisfies @iarna/toml's JsonMap input without a brittle structural cast. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clean<T>(obj: T): any {
  return JSON.parse(JSON.stringify(obj));
}

/** Write a changed name→value map back into rows, keeping order, flags and disabled rows. */
export function mergeRows(rows: KeyVal[], next: Record<string, string>): KeyVal[] {
  const out: KeyVal[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.on || !r.key) {
      out.push(r); // disabled rows are invisible to scripts — keep them as they were
      continue;
    }
    if (!(r.key in next)) continue; // unset by the script
    out.push({ ...r, value: next[r.key] });
    seen.add(r.key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (!seen.has(key) && !rows.some((r) => r.on && r.key === key)) out.push({ key, value, on: true });
  }
  return out;
}

export class ApiStore {
  private readonly dir: string;
  private readonly colDir: string;
  private readonly envDir: string;
  private readonly metaPath: string;
  private readonly globalsPath: string;
  private readonly historyPath: string;
  private history: HttpExchange[] = [];
  private activeEnvId: string | null = null;
  private globals: KeyVal[] = [];
  private watchers: FSWatcher[] = [];
  private changeTimer: NodeJS.Timeout | null = null;
  /** Our own writes also fire the watcher; ignore events right after one. */
  private quietUntil = 0;
  /** Called when a collection/environment file changed on disk outside the app. */
  onExternalChange: () => void = () => {};

  constructor(configDir: string) {
    this.dir = join(configDir, 'api');
    this.colDir = join(this.dir, 'collections');
    this.envDir = join(this.dir, 'environments');
    this.metaPath = join(this.dir, 'meta.toml');
    this.globalsPath = join(this.dir, 'globals.toml');
    this.historyPath = join(this.dir, 'history.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.colDir, { recursive: true });
    await fs.mkdir(this.envDir, { recursive: true });
    try {
      const m = TOML.parse(await fs.readFile(this.metaPath, 'utf8'));
      this.activeEnvId = (m.activeEnvId as string) || null;
    } catch {
      /* first run */
    }
    try {
      const g = TOML.parse(await fs.readFile(this.globalsPath, 'utf8'));
      this.globals = Array.isArray(g.vars) ? (g.vars as unknown as KeyVal[]) : [];
    } catch {
      this.globals = [];
    }
    try {
      this.history = JSON.parse(await fs.readFile(this.historyPath, 'utf8')) as HttpExchange[];
    } catch {
      this.history = [];
    }
    for (const d of [this.colDir, this.envDir]) {
      try {
        this.watchers.push(watch(d, () => this.externalChange()));
      } catch {
        /* watching is a convenience; the app works without it */
      }
    }
  }

  dispose(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  async collections(): Promise<Collection[]> {
    return (await this.readAll<Collection>(this.colDir)).map((c) => normalizeCollection(c, randomUUID));
  }

  async environments(): Promise<Environment[]> {
    return (await this.readAll<Environment>(this.envDir)).map((e) => ({ ...e, vars: Array.isArray(e.vars) ? e.vars : [] }));
  }

  get activeEnv(): string | null {
    return this.activeEnvId;
  }

  getGlobals(): KeyVal[] {
    return this.globals;
  }

  async collection(id: string): Promise<Collection | undefined> {
    return (await this.collections()).find((c) => c.id === id);
  }

  async environment(id: string | null): Promise<Environment | undefined> {
    if (!id) return undefined;
    return (await this.environments()).find((e) => e.id === id);
  }

  async saveCollection(col: Collection): Promise<Collection> {
    const c = normalizeCollection(col, randomUUID);
    await this.atomicWrite(join(this.colDir, `${safeName(c.id)}.toml`), TOML.stringify(clean(c)));
    return c;
  }

  async deleteCollection(id: string): Promise<void> {
    this.quiet();
    await fs.rm(join(this.colDir, `${safeName(id)}.toml`), { force: true });
  }

  async saveEnvironment(env: Environment): Promise<Environment> {
    if (!env.id) env.id = randomUUID();
    await this.atomicWrite(join(this.envDir, `${safeName(env.id)}.toml`), TOML.stringify(clean(env)));
    return env;
  }

  async deleteEnvironment(id: string): Promise<void> {
    this.quiet();
    await fs.rm(join(this.envDir, `${safeName(id)}.toml`), { force: true });
    if (this.activeEnvId === id) await this.setActiveEnv(null);
  }

  async setActiveEnv(id: string | null): Promise<void> {
    this.activeEnvId = id;
    await this.atomicWrite(this.metaPath, TOML.stringify({ activeEnvId: id ?? '' }));
  }

  async saveGlobals(rows: KeyVal[]): Promise<void> {
    this.globals = rows;
    await this.atomicWrite(this.globalsPath, TOML.stringify(clean({ vars: rows })));
  }

  /** Persist variables a script changed (pm.environment/globals/collectionVariables.set). */
  async writeBackVars(p: {
    envId: string | null;
    environment?: Record<string, string>;
    globals?: Record<string, string>;
    collectionId?: string;
    collection?: Record<string, string>;
  }): Promise<void> {
    if (p.globals) await this.saveGlobals(mergeRows(this.globals, p.globals));
    if (p.environment && p.envId) {
      const env = await this.environment(p.envId);
      if (env) await this.saveEnvironment({ ...env, vars: mergeRows(env.vars, p.environment) });
    }
    if (p.collection && p.collectionId) {
      const col = await this.collection(p.collectionId);
      if (col) await this.saveCollection({ ...col, variables: mergeRows(col.variables ?? [], p.collection) });
    }
  }

  addHistory(ex: HttpExchange): void {
    this.history.unshift(ex);
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    void this.atomicWrite(this.historyPath, JSON.stringify(this.history)).catch(() => {});
  }

  listHistory(): HttpExchange[] {
    return this.history;
  }

  async deleteHistory(id: string): Promise<void> {
    this.history = this.history.filter((h) => h.id !== id);
    await this.atomicWrite(this.historyPath, JSON.stringify(this.history));
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.atomicWrite(this.historyPath, '[]');
  }

  // --- internals -----------------------------------------------------------

  private quiet(): void {
    this.quietUntil = Date.now() + 800;
  }

  private externalChange(): void {
    if (Date.now() < this.quietUntil) return;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.onExternalChange(), 250);
  }

  private async readAll<T>(dir: string): Promise<T[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const n of names.sort()) {
      if (!n.endsWith('.toml')) continue;
      try {
        out.push(TOML.parse(await fs.readFile(join(dir, n), 'utf8')) as unknown as T);
      } catch {
        /* skip a malformed file rather than fail the whole load */
      }
    }
    return out;
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    this.quiet();
    const tmp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
  }
}

/** Ids come from the UI: never let one walk out of its folder. */
function safeName(id: string): string {
  return String(id).replace(/[^\w.-]/g, '_');
}
