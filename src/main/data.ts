import { dialog } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import type { Browser } from './browser';
import type { MainWindow } from './window';
import type { Bookmark, HistoryEntry, Prefs, SavedSession, SearchConfig } from '../shared/ipc-contract';
import type { ShortcutConfig } from '../shared/shortcuts';

/**
 * One portable JSON file with everything Bro stores itself: bookmarks,
 * history, saved sessions, the tabs open right now, shortcuts, search
 * engines and prefs. Cookies/sign-ins are NOT included — they live in
 * Chromium's own cookie database under userData/Network and stay on this
 * machine (a backup file holding live session cookies would be a liability).
 */
interface BroBackup {
  app: 'bro';
  version: 1;
  exportedAt: string;
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  sessions: SavedSession[];
  shortcuts: ShortcutConfig;
  search: SearchConfig;
  prefs: Prefs;
}

export async function exportData(mw: MainWindow, browser: Browser): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(mw.win, {
    title: 'Export Bro data',
    defaultPath: `bro-backup-${stamp}.json`,
    filters: [{ name: 'Bro backup', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;

  // The tabs open right now go in as one more saved session.
  const open = browser.tabs.snapshot().tabs;
  const sessions = open.length
    ? [{ id: `open-${Date.now()}`, name: `Open tabs (exported ${stamp})`, ts: Date.now(), tabs: open }, ...browser.sessions.list()]
    : browser.sessions.list();

  const backup: BroBackup = {
    app: 'bro',
    version: 1,
    exportedAt: new Date().toISOString(),
    bookmarks: browser.library.getBookmarks(),
    history: browser.library.getHistory(),
    sessions,
    shortcuts: browser.shortcuts.config,
    search: browser.search.get(),
    prefs: browser.getPrefs(),
  };
  await writeFile(filePath, JSON.stringify(backup, null, 2), 'utf8');
  return filePath;
}

/** Bookmarks/history/sessions are merged; shortcuts, search and prefs are replaced. */
export async function importData(mw: MainWindow, browser: Browser): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(mw.win, {
    title: 'Import Bro data',
    properties: ['openFile'],
    filters: [{ name: 'Bro backup', extensions: ['json'] }],
  });
  if (canceled || !filePaths[0]) return null;

  let data: Partial<BroBackup>;
  try {
    data = JSON.parse(await readFile(filePaths[0], 'utf8'));
  } catch {
    return "Couldn't read that file — is it a Bro backup (.json)?";
  }
  if (data?.app !== 'bro') return "That file isn't a Bro backup.";

  const b = browser.library.importBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : []);
  const h = browser.library.importHistory(Array.isArray(data.history) ? data.history : []);
  const s = browser.sessions.importSaved(Array.isArray(data.sessions) ? data.sessions : []);
  if (data.shortcuts) browser.shortcuts.importConfig(data.shortcuts);
  if (data.search) browser.search.set(data.search);
  if (data.prefs) browser.setPrefs(data.prefs);

  return `Imported ${b} bookmarks, ${h} history entries and ${s} sessions; shortcuts, search engines and startup settings were replaced.`;
}
