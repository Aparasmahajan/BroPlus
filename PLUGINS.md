# Bro_plus — Plugin Catalog

Every feature is a **plugin**, selected at **build time**. The browser shell
(window, tabs, omnibox, mode switch, settings shell, plugin host) is **core** and
always present. This file is the catalog: it marks each plugin, what kind it is,
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
| **overlay-hiding** | capability | `overlay-hiding` | — | Settings → Privacy; hotkey `Ctrl/Cmd+Shift+H` | ✅ working | window is an ordinary, capturable browser (no `setContentProtection`) |
| **opacity** | capability | `opacity` | — | Settings → Appearance; hotkeys `Ctrl/Cmd+Shift+]` `[` | ✅ working | window is always solid; no opacity slider/hotkeys |
| **api-client** | surface | `api-client` | `diff` | mode **API** | ✅ full (collections, environments, `{{vars}}`, auth, body, response + diff, history) | no API mode button; no `api:send` |
| **proxy** | surface | `proxy` | `diff` | mode **Proxy** | ✅ full (mockttp MITM, HTTP history, intercept/edit/forward/drop, Repeater, scope, CA export) | no Proxy mode button; no intercept/history/Repeater |
| **diff** | library | `diff` | — | — | ✅ working (`diffLines`, `prettyForDiff`) | API/Proxy can't be enabled (dependsOn) |
| **adblock** | capability | `adblock` | — | — | 🚧 slot reserved (engine later) | no request-level ad/tracker blocking |

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
5. Register IPC/hotkeys/engines inside `registerMain(ctx)` using `MainContext`.
   Core files don't change — that's the point of the plugin host.
