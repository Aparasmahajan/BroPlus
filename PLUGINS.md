# Bro_plus — Plugin Catalog

Every optional feature is a **plugin**, selected at **build time**. The browser
is **core** and always present — everything Bro has: tabs (private tabs, reopen,
duplicate, sleeping restored tabs), omnibox with search keywords, profiles,
bookmarks/history/sessions (Library), the segmented download manager + torrents,
Save for offline (yt-dlp/ffmpeg), Chrome extensions + Web Store, right-click
menus, find/zoom/print/devtools, rebindable shortcuts + master switch + boss key,
overlay mode (click-through), backup import/export, Widevine (castlabs Electron),
auto-update — plus the mode switch, Settings shell and plugin host. This file is the catalog: it marks each plugin, what kind it is,
its build flag, dependencies, status, and what excluding it does.

## How selection works

- Edit `plugins.config.json` → `enabled`, **or** set `BRO_PLUGINS` (comma list)
  to override it for one build: `BRO_PLUGINS=overlay-hiding,opacity npm run start`.
- `esbuild.mjs` codegens `src/generated/active-plugins.ts` importing **only**
  enabled plugins — excluded ones are never referenced and are tree-shaken out of
  the bundle. Their UI panels aren't built or copied either.
- `dependsOn` (from each plugin's `plugin.json`) is enforced: enabling a plugin
  without its dependencies **fails the build** with a clear message.

## Plugin kinds

- **surface** — adds a top-level mode + panel (a button in the mode switch).
- **capability** — behavior with no panel of its own; may add a Settings section,
  IPC and hotkeys.
- **library** — pure code other plugins import; no runtime side effects.

## Catalog

| id | Kind | Build flag (id) | Depends on | Surface / mode | Status | Excluding it… |
|---|---|---|---|---|---|---|
| **overlay-hiding** | capability | `overlay-hiding` | — | Settings → Privacy; rebindable hotkey `Ctrl/Cmd+Shift+H` | ✅ working | window is an ordinary, capturable browser (no `setContentProtection`); its shortcut and menu item vanish |
| **opacity** | capability | `opacity` | — | Settings → Appearance; rebindable hotkeys `Ctrl/Cmd+Shift+]` `[` `\` | ✅ working | window is always solid; no opacity slider/hotkeys |
| **api-client** | surface | `api-client` | `diff` | mode **API** | ✅ Postman-class: nested folders, globals / collection vars / environments / data-file vars, `{{$dynamic}}` vars, vault secrets (`${vault:}`/`${env:}`), auth (inherit, bearer, basic, API key, OAuth 2 client-credentials/password), every body type (JSON, text, XML, urlencoded, form-data + files, binary, GraphQL), pre-request + test scripts (`pm.*`, QuickJS sandbox), collection runner (iterations, CSV/JSON data, `setNextRequest`), import (Postman v2.x, OpenAPI 3/Swagger 2 JSON+YAML, cURL) / export (Postman v2.1), code snippets, browser cookie jar, redirects/TLS/timeout settings, send through the Proxy, response pretty/raw/preview/diff, history | no API mode button, no API channels |
| **proxy** | surface | `proxy` | `diff` | mode **Proxy** | ✅ full (mockttp MITM, HTTP history, intercept/edit/forward/drop, Repeater, scope, CA export) | no Proxy mode button; no intercept/history/Repeater |
| **diff** | library | `diff` | — | — | ✅ working (`diffLines`, `prettyForDiff`) | API/Proxy can't be enabled (dependsOn) |
| **adblock** | capability | `adblock` | — | toolbar shield counter; Settings → Privacy | ✅ working (Ghostery engine on every tab session — default, profiles, private — + YouTube ad shield preload) | no ad/tracker blocking, no YouTube shield, no shield counter |

> The three headline suites map to: **overlay-hiding** (invisible overlay),
> **api-client** (Postman), **proxy** (Burp). `diff` is the shared compare engine
> both API and Proxy use; `opacity` and `adblock` are extra browser capabilities.

## Example builds

Set in `plugins.config.json` (see its `examples`) or via `BRO_PLUGINS`:

```
# Just a stealth browser (no API, no proxy)
BRO_PLUGINS=overlay-hiding,opacity npm run start

# API workbench (Postman-style), still invisible
BRO_PLUGINS=overlay-hiding,opacity,api-client,diff npm run start

# Full security suite (Burp + Postman + stealth)
BRO_PLUGINS=overlay-hiding,opacity,api-client,proxy,diff npm run start
```

## Adding a new plugin

1. Create `src/plugins/<id>/main.ts` exporting `default { manifest, registerMain? }`.
2. If it needs a panel: add `src/plugins/<id>/ui/panel.ts` + `panel.html`
   (reference `<id>.js`), and set `manifest.surface = { mode, label, html: '<id>.html' }`.
3. If it depends on other plugins: add `src/plugins/<id>/plugin.json`
   `{ "dependsOn": [...] }` **and** mirror it in `manifest.dependsOn`.
4. Add `<id>` to `plugins.config.json` → `enabled`.
5. Register IPC/hotkeys/engines inside `registerMain(ctx)` using `MainContext`:
   `onSession` (every browsing session, incl. profiles + private), `onWindow`,
   `onStarted` (deferred work), `sendToUi`, `registerHotkey` (fixed global key).
   Core files don't change — that's the point of the plugin host.
6. Optional: `src/plugins/<id>/preload.ts` is built to `dist/preload/<id>.js` (a
   session preload the plugin registers itself, like adblock's YouTube shield).
7. Optional rebindable shortcut: add a command to `src/shared/shortcuts.ts` with
   `plugin: '<id>'` and a handler in `src/main/commands.ts`; it is bound, listed
   in Settings and shown in the menu only in builds that include the plugin.
