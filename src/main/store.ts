import { app } from 'electron';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from './fs-atomic';

/**
 * Tiny JSON-file persistence in the app's userData dir. No native deps.
 * Each collection is one file; writes are debounced so rapid updates
 * (e.g. history on every navigation) don't thrash the disk.
 */
export class JsonStore<T> {
  private data: T;
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(name: string, fallback: T) {
    const dir = join(app.getPath('userData'), 'data');
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${name}.json`);
    this.data = this.read(fallback);
  }

  get(): T {
    return this.data;
  }

  set(next: T): void {
    this.data = next;
    this.scheduleWrite();
  }

  update(fn: (draft: T) => T): void {
    this.set(fn(this.data));
  }

  private read(fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private scheduleWrite(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      writeFileAtomicSync(this.file, JSON.stringify(this.data)); // a crash mid-write can't truncate it
    } catch (e) {
      console.error(`[store] failed to write ${this.file}`, e);
    }
  }
}
