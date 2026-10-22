import { JsonStore } from './store';
import { Event, type Bookmark, type HistoryEntry } from '../shared/ipc-contract';

const HISTORY_CAP = 2000;

/**
 * Bookmarks + browsing history of one profile, persisted as JSON and broadcast
 * to the UI. The default profile keeps the original file names.
 */
export class Library {
  private bookmarks: JsonStore<Bookmark[]>;
  private history: JsonStore<HistoryEntry[]>;

  constructor(
    private emit: (channel: string, payload: unknown) => void,
    profileId = 'default',
  ) {
    const suffix = profileId === 'default' ? '' : `-${profileId}`;
    this.bookmarks = new JsonStore<Bookmark[]>(`bookmarks${suffix}`, []);
    this.history = new JsonStore<HistoryEntry[]>(`history${suffix}`, []);
  }

  // --- History -------------------------------------------------------------

  addVisit(url: string, title: string): void {
    if (!/^https?:/i.test(url)) return; // skip start page / about:blank / file://
    const list = this.history.get();
    const last = list[0];
    if (last && last.url === url) {
      last.title = title || last.title; // same page, just refine the title
    } else {
      list.unshift({ url, title: title || url, ts: Date.now() });
      if (list.length > HISTORY_CAP) list.length = HISTORY_CAP;
    }
    this.history.set(list);
    this.emit(Event.HistoryChanged, this.getHistory());
  }

  getHistory(): HistoryEntry[] {
    return this.history.get();
  }

  clearHistory(): void {
    this.history.set([]);
    this.emit(Event.HistoryChanged, []);
  }

  // --- Bookmarks -----------------------------------------------------------

  isBookmarked(url: string): boolean {
    return this.bookmarks.get().some((b) => b.url === url);
  }

  toggleBookmark(url: string, title: string): void {
    if (!/^https?:/i.test(url)) return;
    const list = this.bookmarks.get();
    const idx = list.findIndex((b) => b.url === url);
    if (idx >= 0) list.splice(idx, 1);
    else list.unshift({ url, title: title || url, ts: Date.now() });
    this.bookmarks.set(list);
    this.emit(Event.BookmarksChanged, this.getBookmarks());
  }

  removeBookmark(url: string): void {
    this.bookmarks.update((list) => list.filter((b) => b.url !== url));
    this.emit(Event.BookmarksChanged, this.getBookmarks());
  }

  getBookmarks(): Bookmark[] {
    return this.bookmarks.get();
  }

  // --- Import (from a Bro backup) -----------------------------------------

  /** Add bookmarks we don't have yet; returns how many were new. */
  importBookmarks(incoming: Bookmark[]): number {
    const have = new Set(this.bookmarks.get().map((b) => b.url));
    const fresh = incoming.filter((b) => b && /^https?:/i.test(b.url) && !have.has(b.url));
    if (fresh.length) {
      this.bookmarks.update((list) => [...list, ...fresh].sort((a, b) => b.ts - a.ts));
      this.emit(Event.BookmarksChanged, this.getBookmarks());
    }
    return fresh.length;
  }

  /** Merge history (newest first, capped); returns how many entries were new. */
  importHistory(incoming: HistoryEntry[]): number {
    const key = (h: HistoryEntry) => `${h.ts}|${h.url}`;
    const have = new Set(this.history.get().map(key));
    const fresh = incoming.filter((h) => h && /^https?:/i.test(h.url) && !have.has(key(h)));
    if (fresh.length) {
      this.history.update((list) => [...list, ...fresh].sort((a, b) => b.ts - a.ts).slice(0, HISTORY_CAP));
      this.emit(Event.HistoryChanged, this.getHistory());
    }
    return fresh.length;
  }

  flush(): void {
    this.bookmarks.flush();
    this.history.flush();
  }
}
