import { app, session, type Session } from 'electron';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { JsonStore } from './store';
import { PROFILE_COLORS, type Profile } from '../shared/ipc-contract';

export { PROFILE_COLORS };

export const DEFAULT_PROFILE = 'default';

interface ProfilesData {
  profiles: Profile[];
  /** Last profile the user worked in — new tabs at startup open there. */
  current: string;
  /** Removed profiles whose on-disk session folder is deleted at next launch. */
  pendingDelete: string[];
}

const partitionFor = (id: string) => (id === DEFAULT_PROFILE ? '' : `persist:bro-profile-${id}`);

/**
 * Profiles = separate browsers inside Bro. The default profile keeps using
 * Electron's default session (so existing cookies, logins and extensions stay
 * put); every other profile gets its own persistent partition.
 */
export class Profiles {
  private store: JsonStore<ProfilesData>;

  constructor() {
    this.store = new JsonStore<ProfilesData>('profiles', {
      profiles: [{ id: DEFAULT_PROFILE, name: 'Personal', color: PROFILE_COLORS[0] }],
      current: DEFAULT_PROFILE,
      pendingDelete: [],
    });
    this.purgeDeleted();
  }

  list(): Profile[] {
    return this.store.get().profiles;
  }

  get(id: string): Profile | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** A profile id that exists (falls back to the default one). */
  valid(id: string | undefined): string {
    return id && this.get(id) ? id : DEFAULT_PROFILE;
  }

  get current(): string {
    return this.valid(this.store.get().current);
  }

  setCurrent(id: string): void {
    if (id !== this.store.get().current) this.store.update((d) => ({ ...d, current: this.valid(id) }));
  }

  partition(id: string): string {
    return partitionFor(this.valid(id));
  }

  session(id: string): Session {
    const p = this.partition(id);
    return p ? session.fromPartition(p) : session.defaultSession;
  }

  create(name: string, color: string): Profile {
    const profile: Profile = {
      id: randomBytes(4).toString('hex'),
      name: name.trim().slice(0, 40) || `Profile ${this.list().length + 1}`,
      color: PROFILE_COLORS.includes(color) ? color : PROFILE_COLORS[this.list().length % PROFILE_COLORS.length],
    };
    this.store.update((d) => ({ ...d, profiles: [...d.profiles, profile] }));
    return profile;
  }

  update(id: string, patch: { name?: string; color?: string }): void {
    this.store.update((d) => ({
      ...d,
      profiles: d.profiles.map((p) =>
        p.id !== id
          ? p
          : {
              ...p,
              name: patch.name?.trim() ? patch.name.trim().slice(0, 40) : p.name,
              color: patch.color && PROFILE_COLORS.includes(patch.color) ? patch.color : p.color,
            },
      ),
    }));
  }

  /** The default profile can't be removed. Its data is wiped now and its folder at next launch. */
  remove(id: string): boolean {
    if (id === DEFAULT_PROFILE || !this.get(id)) return false;
    const s = this.session(id);
    void s.clearStorageData().catch(() => {});
    void s.clearCache().catch(() => {});
    this.store.update((d) => ({
      profiles: d.profiles.filter((p) => p.id !== id),
      current: d.current === id ? DEFAULT_PROFILE : d.current,
      pendingDelete: [...d.pendingDelete, id],
    }));
    return true;
  }

  flush(): void {
    this.store.flush();
  }

  /** Chromium keeps a partition's folder locked while it's in use, so delete on the next start. */
  private purgeDeleted(): void {
    const ids = this.store.get().pendingDelete;
    if (!ids.length) return;
    const left = ids.filter((id) => {
      try {
        rmSync(join(app.getPath('userData'), 'Partitions', `bro-profile-${id}`), { recursive: true, force: true });
        rmSync(join(app.getPath('userData'), 'data', `bookmarks-${id}.json`), { force: true });
        rmSync(join(app.getPath('userData'), 'data', `history-${id}.json`), { force: true });
        return false;
      } catch {
        return true; // still locked — try again next launch
      }
    });
    this.store.update((d) => ({ ...d, pendingDelete: left }));
  }
}
