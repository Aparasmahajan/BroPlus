import { randomUUID } from 'node:crypto';
import { JsonStore } from './store';
import { Event, type SavedSession, type SessionTab } from '../shared/ipc-contract';

export interface LastSession {
  tabs: SessionTab[];
  active: number; // index into tabs
}

/**
 * Two ways open tabs are kept:
 *  - the LAST session, autosaved on every tab change and reopened on launch
 *    (when Settings → On startup is "Restore");
 *  - named SAVED sessions, snapshots you take on purpose and reopen later.
 */
export class Sessions {
  private last: JsonStore<LastSession>;
  private saved: JsonStore<SavedSession[]>;

  constructor(private emit: (channel: string, payload: unknown) => void) {
    this.last = new JsonStore<LastSession>('session-last', { tabs: [], active: 0 });
    this.saved = new JsonStore<SavedSession[]>('sessions', []);
  }

  getLast(): LastSession {
    return this.last.get();
  }

  setLast(s: LastSession): void {
    this.last.set(s);
  }

  list(): SavedSession[] {
    return this.saved.get();
  }

  get(id: string): SavedSession | undefined {
    return this.saved.get().find((s) => s.id === id);
  }

  save(name: string, tabs: SessionTab[]): void {
    if (!tabs.length) return;
    const entry: SavedSession = { id: randomUUID(), name: name.trim() || 'Untitled session', ts: Date.now(), tabs };
    this.saved.update((list) => [entry, ...list]);
    this.emit(Event.SessionsChanged, this.list());
  }

  remove(id: string): void {
    this.saved.update((list) => list.filter((s) => s.id !== id));
    this.emit(Event.SessionsChanged, this.list());
  }

  /** Merge sessions from a backup; returns how many were new. */
  importSaved(incoming: SavedSession[]): number {
    const have = new Set(this.saved.get().map((s) => s.id));
    const fresh = incoming.filter((s) => s && s.id && Array.isArray(s.tabs) && !have.has(s.id));
    if (fresh.length) {
      this.saved.update((list) => [...list, ...fresh].sort((a, b) => b.ts - a.ts));
      this.emit(Event.SessionsChanged, this.list());
    }
    return fresh.length;
  }

  flush(): void {
    this.last.flush();
    this.saved.flush();
  }
}
