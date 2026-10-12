// ApiStore — portable persistence for the API client (ARCHITECTURE.md §5.3),
// mirroring OpsPilot's config-as-source-of-truth: collections + environments as
// human-diffable TOML, atomic writes (temp → rename). History is a JSON ring
// (derived, not source of truth). All under <configDir>/api/.
import TOML from '@iarna/toml';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApiState, Collection, Environment } from '../../shared/api-model';
import type { HttpExchange } from '../../shared/http-model';

const HISTORY_MAX = 100;

/** Drop undefined (TOML can't serialize it) by a JSON round-trip. `any` so it
 *  satisfies @iarna/toml's JsonMap input without a brittle structural cast. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clean<T>(obj: T): any {
  return JSON.parse(JSON.stringify(obj));
}

export class ApiStore {
  private readonly dir: string;
  private readonly colDir: string;
  private readonly envDir: string;
  private readonly metaPath: string;
  private readonly historyPath: string;
  private history: HttpExchange[] = [];
  private activeEnvId: string | null = null;

  constructor(configDir: string) {
    this.dir = join(configDir, 'api');
    this.colDir = join(this.dir, 'collections');
    this.envDir = join(this.dir, 'environments');
    this.metaPath = join(this.dir, 'meta.toml');
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
      this.history = JSON.parse(await fs.readFile(this.historyPath, 'utf8')) as HttpExchange[];
    } catch {
      this.history = [];
    }
  }

  async state(): Promise<ApiState> {
    const collections = await this.readAll<Collection>(this.colDir);
    const environments = await this.readAll<Environment>(this.envDir);
    return { collections, environments, activeEnvId: this.activeEnvId };
  }

  async saveCollection(col: Collection): Promise<Collection> {
    if (!col.id) col.id = randomUUID();
    await this.atomicWrite(join(this.colDir, `${col.id}.toml`), TOML.stringify(clean(col)));
    return col;
  }

  async deleteCollection(id: string): Promise<void> {
    await fs.rm(join(this.colDir, `${id}.toml`), { force: true });
  }

  async saveEnvironment(env: Environment): Promise<Environment> {
    if (!env.id) env.id = randomUUID();
    await this.atomicWrite(join(this.envDir, `${env.id}.toml`), TOML.stringify(clean(env)));
    return env;
  }

  async deleteEnvironment(id: string): Promise<void> {
    await fs.rm(join(this.envDir, `${id}.toml`), { force: true });
    if (this.activeEnvId === id) await this.setActiveEnv(null);
  }

  async setActiveEnv(id: string | null): Promise<void> {
    this.activeEnvId = id;
    await this.atomicWrite(this.metaPath, TOML.stringify({ activeEnvId: id ?? '' }));
  }

  addHistory(ex: HttpExchange): void {
    this.history.unshift(ex);
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    void this.atomicWrite(this.historyPath, JSON.stringify(this.history));
  }

  listHistory(): HttpExchange[] {
    return this.history;
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.atomicWrite(this.historyPath, '[]');
  }

  // --- internals -----------------------------------------------------------

  private async readAll<T>(dir: string): Promise<T[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const n of names) {
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
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
  }
}
