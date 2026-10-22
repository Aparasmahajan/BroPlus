# End-to-end tests

These drive the **real app** over the DevTools protocol (main process on
`--inspect=9229`, pages on `--remote-debugging-port=9333`). They are not unit tests
and need a desktop session (windows open on screen). Ported from Bro and adapted to
Bro Plus's plugin build.

Every run uses a throw-away config dir through `BRO_PLUS_CONFIG_DIR`, so the tests
never touch your real profile (`%APPDATA%\bro-plus`), and a test instance can run
next to your own Bro Plus (the single-instance lock is per config dir — only the
two debug ports must be free).

## Run everything

```bash
npm run build
node tests/e2e/run-all.mjs            # every suite, fresh app per suite (25–45 min on the slow dev machine)
node tests/e2e/run-all.mjs main private   # only some: main private context-menu dead-tab stress
                                          # library-tab profiles downloads offline plugin-seams
node tests/e2e/run-all.mjs offline --youtube   # + the real-YouTube offline checks (internet)
node tests/e2e/run-all.mjs --keep     # keep the temp config dirs; each has the app's app.log
```

`run-all.mjs` launches the app, runs the suite, quits it, relaunches for the phases
that need a restart (session restore, profile restart/purge, download crash + resume),
starts the fixture servers, and prints a summary. Exit code 0 = all green.

Notes:

- **`plugin-seams` rebuilds `dist/`.** It builds a browser-only variant
  (`BRO_PLUGINS=overlay-hiding,opacity`) into `tests/e2e/.builds/browser-only/`
  (git-ignored) and then rebuilds the default build back into `dist/` and
  `src/generated/`. Don't run it while you run the app from `dist/` yourself.
- **`offline`** needs ffmpeg + yt-dlp. It looks in `BRO_E2E_TOOLS`, then
  `%APPDATA%\bro-plus\tools`, then Bro's `%APPDATA%\bro-browser\tools`, copies them
  into the test profile (no 50 MB first-run download) and makes the test videos once
  in `%TEMP%\bro-plus-e2e-media` (`fixtures/make-offline-media.mjs`). Without ffmpeg
  the suite is reported as skipped (= failed run).
- Ports: set `BRO_E2E_INSPECT_PORT` / `BRO_E2E_CDP_PORT` to move off 9229 / 9333.
- The machine is slow: app start 15–35 s (2 min for a brand-new profile while
  Widevine installs).
- `launch.mjs` starts the app with Chromium's window-occlusion tracking off. Without
  it, a test window covered by other windows counts as hidden on Windows: pages report
  `visibilityState: hidden`, load slowly, and synthetic mouse input (the real
  right-click check) is dropped. Mouse input is still dropped while the screen is locked.
- Started with `--inspect`, the app **won't exit while a DevTools client is attached
  to the main process** (`Waiting for the debugger to disconnect...` in its log) — close
  your `maineval`/suite connections before quitting. `launch.mjs` flushes cookies,
  quits, and kills the tree (plus any helper still using the config dir) after 30 s.

## Run one suite by hand

```bash
node tests/e2e/launch.mjs [config-dir]     # starts the app with both debug ports; Ctrl+C quits
# in another shell:
NO_PROXY='*' node tests/e2e/main-suite.mjs run          # quit + relaunch same dir, then:
NO_PROXY='*' node tests/e2e/main-suite.mjs restore-check
NO_PROXY='*' node tests/e2e/private-suite.mjs
NO_PROXY='*' node tests/e2e/context-menu-suite.mjs
NO_PROXY='*' node tests/e2e/dead-tab.mjs
NO_PROXY='*' node tests/e2e/open-close-stress.mjs 10 0
NO_PROXY='*' node tests/e2e/library-tab-suite.mjs
NO_PROXY='*' node tests/e2e/plugin-seams-suite.mjs full
# browser-only build: BRO_PLUGINS=overlay-hiding,opacity npm run build, then
NO_PROXY='*' node tests/e2e/plugin-seams-suite.mjs browser-only

# profiles + downloads need the download server
node tests/e2e/fixtures/download-server.mjs 8765 &
NO_PROXY='*' node tests/e2e/profiles-suite.mjs run        # quit, relaunch:
NO_PROXY='*' node tests/e2e/profiles-suite.mjs restart    # prints WORK_ID=…; quit, relaunch:
NO_PROXY='*' node tests/e2e/profiles-suite.mjs purged <WORK_ID>
NO_PROXY='*' node tests/e2e/downloads-suite.mjs run <empty-folder>
NO_PROXY='*' node tests/e2e/downloads-suite.mjs crash-start <folder>  # kill the app hard, relaunch:
NO_PROXY='*' node tests/e2e/downloads-suite.mjs crash-check <folder>

# offline: test videos + server, tools in <config-dir>/tools
node tests/e2e/fixtures/make-offline-media.mjs <ffmpeg.exe> <media-folder>
node tests/e2e/fixtures/offline-server.mjs 8766 <media-folder> &
NO_PROXY='*' node tests/e2e/offline-suite.mjs run <empty-folder> [youtube]
```

Use a fresh config dir per suite (the suites assume a fresh launch).

## Suites

| Suite | What it covers |
| --- | --- |
| `main-suite.mjs` | Chrome bar, every bridge getter + the plugin `*:get` channels, real key presses, rebinding/stealing/master switch/recording, custom shortcuts, search keywords, find, zoom, sessions + Library, prefs, boss key, adblock reload/toggle + opacity + screen-share hiding over the plugin bus, Settings rendering; `restore-check` after a restart |
| `private-suite.mjs` | Private tabs: in-memory session, badge, cookies, ad blocking on/off, no history, popups, never saved, wipe on last close |
| `context-menu-suite.mjs` | Right-click menus (link, image, selection, editable, page, private tab, address bar) |
| `dead-tab.mjs` | Tabs whose page dies from outside / private popups that close themselves |
| `open-close-stress.mjs` | Ctrl+T then Ctrl+W at once, N times; the main process survives |
| `library-tab-suite.mjs` | `bro://downloads` / `bro://offline` Library tabs, bridge isolation, session snapshot |
| `profiles-suite.mjs` | Profiles: partitions, isolation, history/bookmarks, extensions, ad blocking, links, menu, downloads; restart + delete + purge |
| `downloads-suite.mjs` | Segmented engine, pause/resume, retries, changed file, no-range fallback, cancel, private downloads, Library; crash + resume |
| `offline-suite.mjs` | Save for offline: page + video, conversion, pause/resume, multi-video, guarded HLS/DRM; optional real YouTube |
| `plugin-seams-suite.mjs` | Plugin seams. `full`: mode switch built from surfaces, API/Proxy panels shown/hidden, activating or opening a tab returns to Browse, shield + Settings rows. `browser-only`: no mode switch, `setMode` can't reach a missing plugin, no shield / adblock row / `adblock:*` handler / adblock preload; overlay + opacity still work |

Unit tests (no app needed): `node --test "tests/unit/*.test.ts"` (Node 24 runs `.ts` directly).

Last verified (2026-10-15, castlabs Electron 44.5.1): every suite green — main 49 + restore 3,
private 23, context-menu 12, dead-tab 5, stress 2, library-tab 7, profiles 17 + 4 + 2,
downloads 17 + crash 3, offline 25, plugin-seams 14 (full) + 11 (browser-only); unit 6.
Known flaky: downloads "a file that changed on the server is re-fetched" failed once in four runs
(finished with the wrong hash) — suspected race in the segmented engine, not the test.

## Helpers

- `launch.mjs` — start the app isolated (also a module: `launch()` → `{ quit, kill }`).
- `lib.mjs` — `connectMain()` → `M(code)` runs `code` in the main process with `E`
  (electron), `fs`, `path`, `wait(ms)` in scope; `chromeEval`, `page`, `waitFor`, `checker`.
- `maineval.mjs "<expr>"` — evaluate in the main process (`require` works at the top
  level of the expression).
- `cdp.mjs <url-substring> "<expr>"` — evaluate in every page whose URL matches (`'*'` for all).

## Tricks the scripts rely on

- Keys: `webContents.sendInputEvent` (CDP key events skip `before-input-event`).
- Close tabs through the app (`bro.closeTab` / `runCommand('tab.close')`), never
  `webContents.close()` directly (except `dead-tab.mjs`, which tests exactly that).
- Native menus: `Menu.prototype.popup` is patched in main to capture the menu, then
  `item.click()` is called.
- Plugin features are only reachable over the generic bus:
  `bro.plugin.invoke('overlay:get' | 'opacity:get' | 'adblock:get')`,
  `bro.plugin.send('overlay:set' | 'opacity:set' | 'opacity:nudge' | 'adblock:set' | 'adblock:reload', …)`.
  The mode switch is `bro.setMode('browse' | 'api' | 'proxy')`; the chrome mirrors it in
  `document.body.dataset.mode`.
