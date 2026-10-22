# Bro Plus

One screen-share-invisible Chromium browser that fuses **Browse** (everything
[Bro](../Bro) does) + a Postman-class **API** client + a Burp-class intercepting
**Proxy**, as build-selectable plugins. Design: [ARCHITECTURE.md](./ARCHITECTURE.md) ·
plugins: [PLUGINS.md](./PLUGINS.md) · plan: [ROADMAP.md](./ROADMAP.md).

The browser is the core. Screen-share hiding, opacity and ad blocking are plugins
(on in the default build); API and Proxy are surface plugins reached from the
**Browse / API / Proxy** mode switch in the toolbar. A build without a plugin has
no trace of it (no button, no setting, no shortcut, no code).

---

## API mode (Postman-class)

Collections with nested folders · globals, collection variables, environments,
data-file and `{{$guid}}`-style dynamic variables · secrets in an encrypted vault
(`${vault:name}`, `${env:NAME}` — never saved in a collection or the history) ·
auth inherited folder → collection: Bearer, Basic, API key, OAuth 2 (client
credentials / password, "Get new access token") · bodies: JSON, text, XML,
urlencoded, form-data with files, binary, GraphQL · Postman-compatible
pre-request and test scripts (`pm.test`, `pm.expect`, `pm.environment.set`…) in a
locked QuickJS sandbox · collection runner with iterations, CSV/JSON data files
and `pm.execution.setNextRequest` · import Postman v2.x / OpenAPI 3 / Swagger 2
(JSON or YAML) / cURL (also by pasting into the URL bar), export Postman v2.1 ·
code snippets (cURL, PowerShell, fetch, Python, Go, HTTPie) · response pretty /
raw / sandboxed HTML preview, headers, cookies, test results, console, the exact
request sent, diff vs the previous send · per-request timeout, redirects, TLS
verification · **the browser's cookie jar**: sign in in a tab and the API client
is signed in too (and vice versa) · optional **send through the Proxy** so the
request lands in Proxy history. Ctrl+Enter sends, Ctrl+S saves.

---

## Features

| Area | What you get |
|---|---|
| **Screen-share invisibility** *(overlay-hiding plugin)* | `setContentProtection` → `WDA_EXCLUDEFROMCAPTURE` (Windows) / `NSWindowSharingNone` (macOS). Default ON. |
| **Opacity** *(opacity plugin)* | Whole-window opacity, floored at 20% so you can't lose it. |
| **Overlay mode** | Click-through + always-on-top — a passive floating pane that lets clicks pass to the app beneath. |
| **Boss key** | One key hides Bro completely (no taskbar/dock entry) and brings it straight back. |
| **Tabs** | Real isolated Chromium tabs (`WebContentsView`): new/close/switch, reopen closed, duplicate, jump to tab 1–9, favicons, loading state. |
| **Omnibox** | URL or search; **site-search keywords** (`yt lofi`, `w Electron`, `gh electron`) and a choice of default engine — on the start page too. |
| **Private tabs** | Like Incognito: `Ctrl+Shift+N` or the button next to **+**. Private tabs share one in-memory storage area — cookies and site data are wiped when the last one closes. No history, never saved in sessions, links stay private, extensions off, ads still blocked. |
| **Profiles** | Separate browsers inside Bro (e.g. Work / Personal): each has its own sign-ins and cookies, history, bookmarks and extensions. Profile button in the toolbar; tabs carry their profile's colour; links stay in their profile. |
| **Downloads** | A download manager built in: big files come down over up to 16 parallel connections, every piece's progress is saved, so downloads survive pauses, network drops, crashes and restarts (and continue by themselves). Downloads list with Ctrl+J; pause/resume/cancel/retry/open/show in folder; choose folder, ask-where, connections in Settings. |
| **Save for offline** | Ctrl+S (or the button next to Downloads, which lights up when a page plays a video) saves the page *and* its video for watching without internet: a page snapshot (`page.mhtml`), the video(s) as MP4, English subtitles, and an `index.html` player with speed buttons, resume-where-you-stopped and a lesson list. Works on YouTube and 1000s of sites (via yt-dlp), plain video files and HLS/DASH streams; anything a browser can't play is converted (ffmpeg). Whole playlists/courses, quality 360p–1080p or audio only, one save at a time, pause/resume, auto-retry on network loss, continues after a restart. Library → Offline. DRM-protected video can't be saved. |
| **Right-click menu** | Open link in new / private tab / another profile, Save link/image/page as, Copy image / link, search the selection, spelling suggestions, Inspect, extension items. |
| **Sessions** | Reopens last time's tabs on launch (they load when clicked, so startup stays fast). Save all open tabs as a **named session** and reopen it later. |
| **Find & zoom** | Find in page with match count; Chrome's zoom steps with a badge that resets on click; full screen, print, view source, DevTools. |
| **Ad & tracker blocking** *(adblock plugin)* | Ghostery engine (EasyList, uBlock Origin filters, trackers), in normal and private tabs, cached to disk. Live block count + Retry in Settings. |
| **YouTube ad shield** *(adblock plugin)* | Also inside YouTube players embedded in other sites. Removes ad breaks from YouTube's player data before the player reads it, skips any ad that still slips through, hides feed/banner ads and the "ad blockers not allowed" wall. Follows the ad-blocking switch. |
| **Bookmarks & history** | Star in the address bar; history auto-recorded (2000 cap). **Library** overlay: Bookmarks · History · Sessions, with filter. |
| **Keyboard shortcuts** | Every shortcut is **rebindable** in Settings, groups switch on/off, a **master switch** cuts off chosen groups at once, and **your own shortcuts** open a site or search — in-app or system-wide. |
| **Chrome extensions** | Install from the **Chrome Web Store** (🧩 button → chromewebstore.google.com), toolbar action icons, installed extensions restored on launch. |
| **Your data** | Export/import one `.json` backup (bookmarks, history, sessions, shortcuts, search engines, startup choice); clear history, cookies, cache. |
| **Cross-platform** | One codebase for Windows 11 and macOS. |

---

## Keyboard shortcuts

All of these are defaults — change any of them in **Settings → Keyboard
shortcuts** (click **+**, press the keys). `Ctrl` is `Cmd` on macOS.

**BroBrowsing** — system-wide, so they work mid-meeting while another app is focused:

| Keys | Action |
|---|---|
| `Ctrl+Shift+H` | Toggle screen-share invisibility |
| `Ctrl+Shift+]` / `[` | Opacity up / down |
| `Ctrl+Shift+\` | Reset opacity to solid |
| `Ctrl+Shift+O` | Overlay mode (click-through + float) |
| `Ctrl+Alt+B` | Boss key: hide / show Bro |
| `Ctrl+Shift+S` | Open / close Settings |
| `` Ctrl+Shift+` `` | **Master switch** — cut off / restore the groups you pick (default: BroBrowsing) |

**In the app** (Chrome/Edge conventions):

| Keys | Action |
|---|---|
| `Ctrl+T` / `Ctrl+W` / `Ctrl+Shift+T` | New tab / close tab / reopen closed tab |
| `Ctrl+Shift+N` | New private tab |
| `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+1…8`, `Ctrl+9` | Next / previous / nth / last tab |
| `Alt+Shift+D` | Duplicate tab |
| `Alt+←` / `Alt+→`, `Ctrl+R` / `F5`, `Ctrl+Shift+R` | Back / forward, reload, hard reload |
| `Ctrl+L` / `Alt+D` / `F6`, `Alt+Home` | Address bar, start page |
| `Ctrl+F`, `F3` / `Shift+F3` | Find, next / previous match |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `F11`, `Ctrl+P`, `Ctrl+U`, `F12` | Full screen, print, view source, DevTools |
| `Ctrl+D`, `Ctrl+Y`, `Ctrl+H`, `Ctrl+J` | Bookmark page, Bookmarks & History, History, Downloads |
| `Ctrl+S` | Save page + video for offline |
| `Ctrl+Shift+D` | Save all tabs as a session |
| `Ctrl+,` | Settings |

---


---

## Getting started

Requires Node 20+.

```bash
npm install --install-links   # --install-links copies the webrtc-polyfill stub (see package.json overrides)
npm start                     # build + launch
```

Electron is castlabs' build with Widevine (same as Bro). On a network with TLS
inspection, fetch its binary with `NODE_TLS_REJECT_UNAUTHORIZED=0 node node_modules/electron/install.js`
(the zip is SHA-checked), or copy `node_modules/electron/dist` from a Bro checkout
of the same version. Netflix-style DRM needs VMP signing: `npm run vmp` (see Bro's README).

```bash
BRO_PLUGINS=overlay-hiding,opacity npm start   # browser-only build (no API/Proxy/adblock)
BRO_PLUS_CONFIG_DIR=D:\bro-plus npm start      # portable: all state in one folder
npm run typecheck                              # tsc --noEmit (strict)
npm run pack                                   # unpacked app in release/
```

Data lives in `%APPDATA%\bro-plus` (separate from Bro's `bro-browser` profile).
