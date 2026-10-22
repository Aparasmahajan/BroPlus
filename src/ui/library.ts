// Library page: Bookmarks, History, saved Sessions, Downloads and Offline videos —
// Chrome-style (header with search, side nav, cards). Shown over the page (Ctrl/Cmd+Y)
// or as a tab (bro://downloads …). Uses the privileged `window.bro` bridge.
import {
  DOWNLOAD_PRIORITIES,
  type Bookmark,
  type DownloadAction,
  type DownloadInfo,
  type DownloadPriority,
  type HistoryEntry,
  type ProfilesState,
  type LibraryView,
  type OfflineAction,
  type OfflineItem,
  type Prefs,
  type SavedSession,
} from '../shared/ipc-contract';

const bro = window.bro;
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/** Tiny DOM builder: h('div', { className: 'x' }, child, 'text'). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** An icon from the page's sprite. */
function icon(id: string, cls = 'ico'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

let view: LibraryView = 'bookmarks';
let bookmarks: Bookmark[] = [];
let history: HistoryEntry[] = [];
let sessions: SavedSession[] = [];
let downloads: DownloadInfo[] = [];
let offline: OfflineItem[] = [];
let profiles: ProfilesState | null = null;
let prefs: Prefs | null = null;
let filter = '';

const listEl = $('list');
const emptyEl = $('empty');
const clearBtn = $<HTMLButtonElement>('clear-history');
const filterEl = $<HTMLInputElement>('filter');
const saveForm = $<HTMLFormElement>('save-session');
const sessionName = $<HTMLInputElement>('session-name');
const dlPanel = $('dl-panel');
const viewTabs: Record<LibraryView, HTMLElement> = {
  bookmarks: $('tab-bookmarks'),
  history: $('tab-history'),
  sessions: $('tab-sessions'),
  downloads: $('tab-downloads'),
  offline: $('tab-offline'),
};
const profileNote = $('profile-note');
$('clear-downloads').addEventListener('click', () => bro.clearDownloads());
const clearOfflineBtn = $<HTMLButtonElement>('clear-offline');
clearOfflineBtn.addEventListener('click', () => bro.clearOffline());

/** Opened as a page in a tab (bro://downloads, bro://offline) rather than over the page. */
const inTab = new URLSearchParams(location.search).has('tab');
const VIEWS: Record<LibraryView, { title: string; icon: string; search: string }> = {
  bookmarks: { title: 'Bookmarks', icon: 'i-star', search: 'Search bookmarks' },
  history: { title: 'History', icon: 'i-clock', search: 'Search history' },
  sessions: { title: 'Sessions', icon: 'i-tabs', search: 'Search sessions' },
  downloads: { title: 'Downloads', icon: 'i-download', search: 'Search downloads' },
  offline: { title: 'Offline videos', icon: 'i-offline', search: 'Search offline videos' },
};

// --- Header controls -------------------------------------------------------
$('close').hidden = inTab; // a tab is closed like any tab
$('close').addEventListener('click', () => bro.closeLibrary());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (filterEl.value) {
    filterEl.value = '';
    filter = '';
    render();
  } else if (!inTab) bro.closeLibrary();
});

for (const [v, el] of Object.entries(viewTabs) as [LibraryView, HTMLElement][]) {
  el.addEventListener('click', () => setView(v));
}
clearBtn.addEventListener('click', () => {
  if (confirm('Delete all browsing history?')) bro.clearHistory();
});
filterEl.addEventListener('input', () => {
  filter = filterEl.value.trim().toLowerCase();
  render();
});
saveForm.addEventListener('submit', (e) => {
  e.preventDefault();
  bro.saveSession(sessionName.value);
  sessionName.value = '';
});

function setView(v: LibraryView): void {
  view = v;
  for (const [k, el] of Object.entries(viewTabs)) el.classList.toggle('active', k === v);
  clearBtn.hidden = v !== 'history';
  clearOfflineBtn.hidden = v !== 'offline';
  dlPanel.hidden = v !== 'downloads';
  saveForm.hidden = v !== 'sessions';
  $('page-title').textContent = VIEWS[v].title;
  $('title-icon').setAttribute('href', `#${VIEWS[v].icon}`);
  $('empty-icon').setAttribute('href', `#${VIEWS[v].icon}`);
  filterEl.placeholder = VIEWS[v].search;
  document.title = VIEWS[v].title;
  // The address bar shows bro://<view>.
  if (inTab) window.history.replaceState(null, '', `#${v}`);
  dlLayout = ''; // the list is rebuilt for another view
  render();
}


// --- Formatting ---------------------------------------------------------------
function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Today", "Yesterday", or "Monday, October 6, 2026" — Chrome's day headings. */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  const full = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return days === 0 ? `Today – ${full}` : days === 1 ? `Yesterday – ${full}` : full;
}

function byDay<T>(items: T[], ts: (x: T) => number): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const x of items) {
    const label = dayLabel(ts(x));
    if (out.at(-1)?.label === label) out.at(-1)!.items.push(x);
    else out.push({ label, items: [x] });
  }
  return out;
}

const fmtBytes = (n: number): string => {
  if (n < 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtTime = (s: number): string =>
  s < 60 ? `${Math.ceil(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function prettyUrl(u: string): string {
  if (/^magnet:/i.test(u)) return 'magnet link';
  try {
    return new URL(u).host + new URL(u).pathname.replace(/\/$/, '');
  } catch {
    return u;
  }
}

function setEmpty(show: boolean, text: string): void {
  emptyEl.hidden = !show;
  $('empty-text').textContent = text;
}

// --- Bookmarks / History / Sessions ------------------------------------------

interface Row {
  title: string;
  sub: string;
  meta: string;
  ts: number;
  tooltip?: string;
  open: () => void;
  remove?: { label: string; run: () => void };
}

function rows(): Row[] {
  const match = (...texts: string[]) => !filter || texts.some((t) => t.toLowerCase().includes(filter));
  if (view === 'sessions') {
    return sessions
      .filter((s) => match(s.name, ...s.tabs.flatMap((t) => [t.title, t.url])))
      .map((s) => ({
        title: s.name,
        sub: `${plural(s.tabs.length, 'tab')} · ${s.tabs
          .slice(0, 3)
          .map((t) => t.title || prettyUrl(t.url))
          .join(', ')}${s.tabs.length > 3 ? ', …' : ''}`,
        meta: timeAgo(s.ts),
        ts: s.ts,
        tooltip: s.tabs.map((t) => t.title || t.url).join('\n'),
        open: () => bro.openSession(s.id),
        remove: { label: 'Delete session', run: () => bro.removeSession(s.id) },
      }));
  }
  const items = view === 'bookmarks' ? bookmarks : history;
  return items
    .filter((i) => match(i.title, i.url))
    .map((i) => ({
      title: i.title || prettyUrl(i.url),
      sub: prettyUrl(i.url),
      meta: view === 'history' ? clock(i.ts) : timeAgo(i.ts),
      ts: i.ts,
      tooltip: i.url,
      open: () => {
        bro.navigate(i.url);
        bro.closeLibrary();
      },
      remove: view === 'bookmarks' ? { label: 'Remove bookmark', run: () => bro.removeBookmark(i.url) } : undefined,
    }));
}

function render(): void {
  renderProfileNote();
  if (view === 'downloads') return renderDownloads();
  if (view === 'offline') return renderOffline();
  const list = rows();
  setEmpty(
    list.length === 0,
    filter
      ? 'No results found.'
      : view === 'sessions'
        ? 'No saved sessions yet. Name the tabs you have open and save them above.'
        : view === 'history'
          ? 'Pages you visit will appear here.'
          : 'Bookmark pages with the star in the address bar (Ctrl/Cmd+D).',
  );
  const groups = view === 'history' ? byDay(list, (r) => r.ts) : [{ label: '', items: list }];
  listEl.replaceChildren(
    ...groups.flatMap((g) => [
      ...(g.label ? [h('h3', { className: 'group-title' }, g.label)] : []),
      ...(g.items.length ? [h('div', { className: 'card list-card' }, ...g.items.map(rowEl))] : []),
    ]),
  );
}

function rowEl(item: Row): HTMLElement {
  const main = h(
    'button',
    { className: 'lib-item-main', title: item.tooltip ?? '', onclick: item.open },
    h('span', { className: 'lib-item-title' }, item.title),
    h('span', { className: 'lib-item-url' }, item.sub),
    h('span', { className: 'lib-item-meta' }, item.meta),
  );
  const row = h('div', { className: 'lib-item' }, main);
  if (item.remove) {
    const { label, run } = item.remove;
    const del = h('button', { className: 'icon-btn round', title: label, ariaLabel: label }, icon('i-x'));
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
    });
    row.appendChild(del);
  }
  return row;
}

/** Bookmarks + history belong to a profile; say whose they are when there are several. */
function renderProfileNote(): void {
  const p = profiles && profiles.profiles.length > 1 ? profiles.profiles.find((x) => x.id === profiles!.current) : null;
  profileNote.hidden = !p || (view !== 'bookmarks' && view !== 'history');
  if (p) profileNote.textContent = `Showing ${view} of the ${p.name} profile.`;
}

// --- Downloads -------------------------------------------------------------

const PRIORITY_LABEL: Record<DownloadPriority, string> = { high: 'High', normal: 'Normal', low: 'Low' };

function downloadLine(d: DownloadInfo): string {
  const size = d.total > 0 ? `${fmtBytes(d.received)} of ${fmtBytes(d.total)}` : d.received > 0 ? fmtBytes(d.received) : '';
  const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' · ');
  switch (d.status) {
    case 'queued':
      return join('Queued — starts when a download finishes', size);
    case 'downloading': {
      if (d.engine === 'torrent' && d.total < 0) return join('Getting torrent info from peers…', plural(d.connections, 'peer'));
      const speed = d.speed > 0 && `${fmtBytes(d.speed)}/s`;
      const left = d.speed > 0 && d.total > 0 && `${fmtTime((d.total - d.received) / d.speed)} left`;
      const conns =
        d.engine === 'torrent'
          ? d.connections
            ? plural(d.connections, 'peer')
            : 'looking for peers…'
          : d.engine === 'segmented' && plural(d.connections, 'connection');
      return join(size, speed || (d.engine !== 'torrent' && 'starting…'), left, conns, d.retries > 0 && plural(d.retries, 'retry', 'retries'));
    }
    case 'paused':
      return join('Paused', size);
    case 'interrupted':
      return join('Interrupted', size, d.error ?? 'retrying');
    case 'completed':
      return join(fmtBytes(d.total > 0 ? d.total : d.received), `Done ${timeAgo(d.finished ?? d.started)}`);
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return join('Failed', d.error ?? 'unknown error');
  }
}

/** File-type tile: "ZIP" on amber, "MP4" on red… (Chrome shows the file's icon). */
const KINDS: [RegExp, string][] = [
  [/^(zip|rar|7z|tar|gz|tgz|bz2|xz|iso)$/, 'archive'],
  [/^(mp4|mkv|webm|avi|mov|m4v|wmv|flv|ts)$/, 'video'],
  [/^(mp3|flac|wav|m4a|aac|ogg|opus)$/, 'audio'],
  [/^(png|jpe?g|gif|webp|svg|bmp|ico|heic|avif)$/, 'image'],
  [/^(pdf)$/, 'pdf'],
  [/^(docx?|odt|rtf|txt|md|xlsx?|csv|pptx?)$/, 'doc'],
  [/^(exe|msi|dmg|pkg|appx|deb|rpm|apk)$/, 'app'],
];
function fileTile(d: DownloadInfo): HTMLElement {
  if (d.engine === 'torrent') return h('div', { className: 'file-tile kind-torrent', title: 'Torrent' }, icon('i-magnet'));
  const m = /\.([a-z0-9]{1,5})$/i.exec(d.filename);
  const ext = m ? m[1].toLowerCase() : '';
  const kind = KINDS.find(([re]) => re.test(ext))?.[1] ?? 'file';
  return h('div', { className: `file-tile kind-${kind}` }, ext ? ext.toUpperCase().slice(0, 4) : icon('i-download'));
}

interface Card {
  el: HTMLElement;
  shape: string;
  update: (d: DownloadInfo) => void;
}
const cards = new Map<string, Card>();
/** Last list layout (days, ids, card shapes): cards are only re-laid out when it changes. */
let dlLayout = '';
const isLive = (d: DownloadInfo) => d.status === 'queued' || d.status === 'downloading' || d.status === 'paused' || d.status === 'interrupted';
/** What decides a card's buttons — when it changes the card is rebuilt; otherwise it's updated in place. */
const shapeOf = (d: DownloadInfo) => [d.status, d.engine, d.resumable, d.forced].join('|');

function buildCard(d: DownloadInfo): Card {
  const id = d.id;
  const done = d.status === 'completed';
  const name = done
    ? h('button', { className: 'dl-name link', onclick: () => bro.downloadAction(id, 'open') })
    : h('span', { className: 'dl-name' });
  if (done) name.dataset.action = 'open';
  const tag = h('span', { className: 'dl-tag' });
  const url = h('span', { className: 'dl-url' });
  const fill = h('div', { className: 'dl-fill' });
  const bar = h('div', { className: 'dl-bar' }, fill);
  const meta = h('div', { className: 'dl-meta' });

  const links = h('div', { className: 'dl-links' });
  const act = (label: string, action: DownloadAction, title = label) => {
    const b = h('button', { className: 'link-btn', textContent: label, title, onclick: () => bro.downloadAction(id, action) });
    b.dataset.action = action;
    links.appendChild(b);
  };
  const canPause = d.engine !== 'browser' || d.resumable;
  switch (d.status) {
    case 'queued':
      act('Start now', 'start-now', 'Start it now, without waiting for its turn');
      act('Pause', 'pause');
      act('Cancel', 'cancel');
      break;
    case 'downloading':
      if (canPause) act('Pause', 'pause');
      act('Cancel', 'cancel');
      break;
    case 'paused':
    case 'interrupted':
      act('Resume', 'resume');
      act('Cancel', 'cancel');
      break;
    case 'completed':
      act('Show in folder', 'show');
      break;
    default:
      act('Retry', 'retry');
  }

  const side = h('div', { className: 'dl-side' });
  let prio: HTMLSelectElement | null = null;
  if (isLive(d)) {
    prio = h(
      'select',
      { className: 'prio', title: 'Priority: queued downloads start in this order', ariaLabel: 'Priority' },
      ...DOWNLOAD_PRIORITIES.map((p) => h('option', { value: p }, PRIORITY_LABEL[p])),
    );
    const sel = prio;
    sel.addEventListener('change', () => {
      sel.dataset.p = sel.value;
      bro.setDownloadPriority(id, sel.value as DownloadPriority);
    });
    side.appendChild(sel);
  }
  side.appendChild(
    h('button', {
      className: 'icon-btn round',
      title: 'Remove from list (keeps the file)',
      ariaLabel: 'Remove from list',
      onclick: () => bro.downloadAction(id, 'remove'),
    }, icon('i-x')),
  );

  const main = h('div', { className: 'dl-main' }, h('div', { className: 'dl-title' }, name, tag), url, bar, meta, links);
  const el = h('div', { className: 'card dl-card' }, fileTile(d), main, side);

  const update = (d: DownloadInfo) => {
    el.className = `card dl-card dl-item dl-${d.status}${d.forced ? ' forced' : ''}`;
    name.textContent = d.filename;
    name.title = d.path;
    url.textContent = prettyUrl(d.url);
    url.title = d.url;
    const tags = [d.engine === 'torrent' && 'Torrent', d.forced && 'Started now', d.private && 'Private'].filter(Boolean);
    tag.textContent = tags.join(' · ');
    tag.hidden = !tags.length;
    meta.textContent = downloadLine(d);
    meta.title = meta.textContent;
    bar.hidden = !isLive(d);
    fill.classList.toggle('indeterminate', d.total <= 0 && d.status === 'downloading');
    fill.style.width = d.total > 0 ? `${Math.min(100, (d.received / d.total) * 100).toFixed(1)}%` : d.status === 'downloading' ? '' : '0';
    if (prio && document.activeElement !== prio) {
      prio.value = d.priority;
      prio.dataset.p = d.priority;
    }
  };
  update(d);
  return { el, shape: shapeOf(d), update };
}

function renderDownloads(): void {
  const list = downloads.filter(
    (d) => !filter || d.filename.toLowerCase().includes(filter) || d.url.toLowerCase().includes(filter),
  );
  setEmpty(
    list.length === 0,
    filter
      ? 'No downloads match your search.'
      : 'Files you download appear here. Paste a link or a magnet link above to start one.',
  );
  renderSummary();

  const groups = byDay(list, (d) => d.started);
  const layout = groups.map((g) => `${g.label}:${g.items.map((d) => `${d.id}=${shapeOf(d)}`).join(',')}`).join('|');
  if (layout !== dlLayout) {
    const seen = new Set<string>();
    const nodes: HTMLElement[] = [];
    for (const g of groups) {
      nodes.push(h('h3', { className: 'group-title' }, g.label));
      for (const d of g.items) {
        let c = cards.get(d.id);
        if (!c || c.shape !== shapeOf(d)) {
          c = buildCard(d);
          cards.set(d.id, c);
        }
        seen.add(d.id);
        nodes.push(c.el);
      }
    }
    for (const id of [...cards.keys()]) if (!seen.has(id)) cards.delete(id);
    listEl.replaceChildren(...nodes);
    dlLayout = layout;
  }
  for (const d of list) cards.get(d.id)?.update(d);
}

function renderSummary(): void {
  const running = downloads.filter((d) => d.status === 'downloading').length;
  const queued = downloads.filter((d) => d.status === 'queued').length;
  const paused = downloads.filter((d) => d.status === 'paused' || d.status === 'interrupted').length;
  const speed = downloads.reduce((a, d) => a + (d.status === 'downloading' ? d.speed : 0), 0);
  const max = prefs?.maxDownloads ?? 4;
  const parts = [
    running ? `${running} downloading${speed > 0 ? ` at ${fmtBytes(speed)}/s` : ''}` : 'Nothing downloading',
    queued && `${queued} queued`,
    paused && `${paused} paused`,
    `up to ${max} at a time`,
  ].filter(Boolean);
  $('dl-summary-text').textContent = parts.join(' · ');
  $<HTMLButtonElement>('dl-pause-all').disabled = running + queued === 0;
  $<HTMLButtonElement>('dl-resume-all').disabled = paused === 0;
  $<HTMLButtonElement>('clear-downloads').disabled = !downloads.some((d) => !isLive(d));
  const count = $('nav-dl-count');
  count.hidden = running + queued === 0;
  count.textContent = String(running + queued);
}

$('dl-pause-all').addEventListener('click', () => bro.pauseAllDownloads());
$('dl-resume-all').addEventListener('click', () => bro.resumeAllDownloads());
$('dl-open-folder').addEventListener('click', () => bro.openDownloadsFolder());
$<HTMLFormElement>('dl-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('dl-add-url');
  const msg = $('dl-add-msg');
  if (!input.value.trim()) return;
  const err = await bro.addDownload(input.value);
  msg.textContent = err ?? '';
  msg.classList.toggle('err', !!err);
  if (!err) input.value = '';
});

// --- Offline (saved pages + videos) ------------------------------------------

function offlineLine(o: OfflineItem): string {
  switch (o.status) {
    case 'working': {
      const parts = [o.stage];
      if (o.total > 0 && o.total !== 1000) parts.push(`${fmtBytes(o.received)} of ${fmtBytes(o.total)}`);
      else if (o.total === 1000) parts.push(`${Math.round(o.received / 10)}%`);
      else if (o.received > 0) parts.push(fmtBytes(o.received));
      if (o.speed > 0) parts.push(`${fmtBytes(o.speed)}/s`);
      if (o.eta > 0) parts.push(`${fmtTime(o.eta)} left`);
      return parts.join(' · ');
    }
    case 'queued':
      return 'Waiting for the save before it to finish';
    case 'paused':
      return o.stage && o.stage !== 'Paused' ? `Paused · ${o.stage}` : 'Paused — Resume continues where it stopped';
    case 'interrupted':
      return o.stage;
    case 'completed':
      return `${o.stage} · ${timeAgo(o.finished ?? o.started)}`;
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return `Failed · ${o.error ?? 'unknown error'}`;
  }
}

function renderOffline(): void {
  const list = offline.filter((o) => !filter || o.title.toLowerCase().includes(filter) || o.pageUrl.toLowerCase().includes(filter));
  setEmpty(
    list.length === 0,
    filter
      ? 'Nothing matches.'
      : 'Nothing saved yet. On any page with a video (a course, a talk, a tutorial), press Ctrl/Cmd+S or the ' +
        'Save-for-offline button in the toolbar. Bro keeps the page and the video under “Bro Offline” in your ' +
        'download folder, and you can watch it here without internet.',
  );
  listEl.replaceChildren(
    ...byDay(list, (o) => o.started).flatMap((g) => [
      h('h3', { className: 'group-title' }, g.label),
      ...g.items.map(offlineCard),
    ]),
  );
}

function offlineCard(o: OfflineItem): HTMLElement {
  const done = o.status === 'completed';
  const running = o.status === 'working' || o.status === 'queued';
  const name = done
    ? h('button', { className: 'dl-name link', textContent: o.title, onclick: () => bro.offlineAction(o.id, 'open') })
    : h('span', { className: 'dl-name', textContent: o.title });
  name.title = `${o.pageUrl}\n${o.folder}`;
  const meta = h('div', { className: 'dl-meta', textContent: offlineLine(o) + (o.private ? ' · private' : '') });
  meta.title = meta.textContent ?? '';

  const main = h('div', { className: 'dl-main' }, h('div', { className: 'dl-title' }, name), h('span', { className: 'dl-url', textContent: prettyUrl(o.pageUrl) }));
  if (o.status === 'working') {
    const fill = h('div', { className: 'dl-fill' });
    if (o.total > 0) fill.style.width = `${Math.min(100, (o.received / o.total) * 100).toFixed(1)}%`;
    else fill.classList.add('indeterminate');
    main.appendChild(h('div', { className: 'dl-bar' }, fill));
  }
  main.appendChild(meta);

  const links = h('div', { className: 'dl-links' });
  const act = (label: string, action: OfflineAction, title = label) =>
    links.appendChild(
      h('button', {
        className: 'link-btn' + (action === 'delete' ? ' danger' : ''),
        textContent: label,
        title,
        onclick: () => {
          if (action === 'delete' && !confirm(`Delete “${o.title}” and its saved files from your computer?`)) return;
          bro.offlineAction(o.id, action);
        },
      }),
    );
  if (running) {
    act('Pause', 'pause');
    act('Cancel', 'cancel');
  } else if (o.status === 'paused' || o.status === 'interrupted') {
    act('Resume', 'resume');
    act('Cancel', 'cancel');
  } else if (done) {
    act(o.videos ? 'Watch' : 'Open', 'open');
    act('Show in folder', 'show');
    act('Delete files', 'delete', 'Delete the saved files');
  } else {
    act('Retry', 'retry');
  }
  main.appendChild(links);

  const side = h(
    'div',
    { className: 'dl-side' },
    h('button', { className: 'icon-btn round', title: 'Remove from list (keeps the files)', ariaLabel: 'Remove from list', onclick: () => bro.offlineAction(o.id, 'remove') }, icon('i-x')),
  );
  const tile = h('div', { className: 'file-tile kind-video' }, icon('i-offline'));
  return h('div', { className: `card dl-card dl-${running ? 'downloading' : o.status}` }, tile, main, side);
}

// --- Data sync -------------------------------------------------------------
bro.onBookmarksChanged((b) => {
  bookmarks = b;
  if (view === 'bookmarks') render();
});
bro.onHistoryChanged((hist) => {
  history = hist;
  if (view === 'history') render();
});
// Offline progress redraws the list ~2x a second; never swap a row out from under a click.
let pressing = false;
let redrawPending = false;
listEl.addEventListener('pointerdown', () => (pressing = true));
window.addEventListener('pointerup', () => {
  pressing = false;
  if (redrawPending) {
    redrawPending = false;
    setTimeout(render); // after the click has fired
  }
});
bro.onDownloadsChanged((d) => {
  downloads = d;
  if (view !== 'downloads') return renderSummary();
  if (pressing) redrawPending = true;
  else render();
});
bro.onOfflineChanged((o) => {
  offline = o;
  if (view !== 'offline') return;
  if (pressing) redrawPending = true;
  else render();
});
bro.onPrefsChanged((p) => {
  prefs = p;
  renderSummary();
});
void bro.getPrefs().then((p) => {
  prefs = p;
  renderSummary();
});
void bro.getOffline().then((o) => {
  offline = o;
  if (view === 'offline') render();
});
bro.onProfilesChanged((p) => {
  profiles = p;
  renderProfileNote();
});
void bro.getDownloads().then((d) => {
  downloads = d;
  if (view === 'downloads') render();
  else renderSummary();
});
void bro.getProfiles().then((p) => {
  profiles = p;
  renderProfileNote();
});

bro.onSessionsChanged((s) => {
  sessions = s;
  if (view === 'sessions') render();
});

void bro.getBookmarks().then((b) => {
  bookmarks = b;
  if (view === 'bookmarks') render();
});
void bro.getHistory().then((hist) => {
  history = hist;
  if (view === 'history') render();
});
void bro.getSessions().then((s) => {
  sessions = s;
  if (view === 'sessions') render();
});

// Opened on a specific view (Ctrl/Cmd+H → History, Ctrl/Cmd+Shift+D → Sessions, bro://downloads …).
bro.onLibraryView(setView);
{
  const start = location.hash.slice(1) as LibraryView;
  setView(inTab && start in VIEWS ? start : inTab ? 'downloads' : 'bookmarks');
}
