# Bro_plus — Architecture

**One Electron window, one Chromium engine, three surfaces that share state:**

1. **Browse** — a fast, screen-share-invisible, opacity-adjustable web browser
   (this is `Bro`, carried over whole).
2. **API** — a Postman-class API client: collections, environments/variables,
   request builder, response viewer with **diff mode**, history.
3. **Proxy** — a Burp-class intercepting HTTPS proxy: live intercept/modify, a
   full HTTP history, a **Repeater**, scope rules, and match/replace.

> Lineage: `Bro` (`../Bro`) is the working browser base — WebContentsView tabs,
> `setContentProtection`, opacity, typed IPC. The API-client data model is lifted
> from `../ssh` (OpsPilot): portable **TOML collections** (`api/collections/*.toml`),
> `{{var}}` / `${vault:…}` / `${env:…}` references, an encrypted secrets vault,
> atomic writes, and config-as-source-of-truth. Bro_plus fuses them.

---

## A. Plugin system (the organizing principle)

Bro_plus is a small **core** + feature **plugins**, and which plugins ship is
chosen at **build time** so a build can skip features. Full catalog + flags:
**PLUGINS.md**.

**Core (always present):** the browser shell — window, WebContentsView tabs,
omnibox, the mode switch, the Settings shell, and the **plugin host**.

**Plugin kinds:**
- **surface** — adds a top-level mode + panel (API, Proxy).
- **capability** — behavior with no panel of its own; may add a Settings section,
  IPC and hotkeys (overlay-hiding, opacity, adblock).
- **library** — pure code other plugins import; no side effects (diff).

**Contract** (`src/core/plugin.ts`): a plugin is a module whose default export is
`{ manifest, registerMain?(ctx) }`.
- `manifest`: `id`, `title`, `description`, optional `dependsOn`, optional
  `surface: { mode, label, html }`.
- `registerMain(ctx: MainContext)`: wire IPC, engines, hotkeys and defaults. The
  `MainContext` hands the plugin the window, `ipcMain`, the shared `session`, the
  config dir, `sendToUi`, `registerHotkey`, and the window capabilities
  (`setCaptureHidden`/`setOpacity`/…). Library plugins omit `registerMain`.

**Build-time selection + tree-shaking:**
1. `plugins.config.json` → `enabled`, overridable by the `BRO_PLUGINS` env var.
2. `esbuild.mjs` validates dirs + `dependsOn`, then **codegens**
   `src/generated/active-plugins.ts` importing only enabled plugins. Excluded
   plugins are never referenced → dropped from the bundle; their UI panels aren't
   built or copied.
3. `main/index.ts` (the host) iterates `activePlugins`, registers each surface on
   the `Browser`, and calls `registerMain(ctx)`.

**Runtime discovery:** the chrome's **mode switch** and the **Settings** sections
are built from `bro.activePlugins()` (IPC `plugins:list`), so the UI reflects
exactly the plugins in the running build — an excluded plugin shows no button and
no section. Plugin UIs talk to their main half over a **generic bus**
(`window.bro.plugin.invoke/send/on`) so the preload stays static as features vary.

**Dependency rule:** a plugin lists `dependsOn` in both `plugin.json` (build
check) and `manifest` (runtime); enabling it without its deps fails the build.

---

## 0. Why one app (the thesis)

Today a developer juggles three tools that **refuse to share state**:

- The **browser** has the live session (cookies, bearer tokens, CSRF headers) but
  can't replay or mutate a request.
- **Postman** can craft and replay requests but starts from an empty cookie jar —
  you re-paste auth by hand, and it can't see what the app actually sent.
- **Burp** sees everything on the wire but is a heavy separate proxy you configure
  the browser to trust, and its API-client ergonomics are poor.

Bro_plus collapses them because **the browser *is* the proxy client and the API
client, sharing one Chromium `session`**. One captured exchange flows freely:

```
Browse a page ──▶ Proxy history captures every request (incl. HTTPS, MITM'd)
      │                       │
      │                       ├─▶ "Send to Repeater"  → tweak & resend, diff responses
      │                       ├─▶ "Save to Collection" → becomes a reusable API request
      │                       └─▶ "Copy as curl / fetch"
      ▼                       ▲
API request builder ──────────┘  fire through the SAME proxy & session,
                                 then "Open response in a browser tab"
```

Auth is never re-pasted: the API client and Repeater reuse the browsing
`session`'s cookies by default. That single shared `session` is the architecture's
whole reason to exist — keep it central.

---

## 1. Engine decision

**Electron 32+**, unchanged from Bro's `poc.md` §0. Reasons recap: it *is*
Chromium (Chrome-parity browsing), it gives native window control for the two
signature features, it is one codebase for Win + macOS, and Node in the main
process is exactly where an HTTP engine and an intercepting proxy belong.

The proxy and API engines run in **main** (Node), never the renderer:

- Node can open raw TLS sockets, mint certificates, and make cross-origin
  requests with arbitrary headers — the renderer cannot (CORS, no sockets).
- The renderer stays a thin, sandboxed UI that talks only through typed IPC.

---

## 2. Process & surface model

```
┌──────────────────── MAIN process (Node) ───────────────────────────────┐
│ MainWindow  — frameless · setContentProtection(true) · setOpacity()      │
│                                                                          │
│  contentView (one native window, both flags cover everything in it)      │
│   ├─ chrome        WebContentsView  → top bar + MODE SWITCH (Browse/API/Proxy) │
│   ├─ tab #1..n     WebContentsView  → real web pages  (Browse surface)   │
│   ├─ apiPanel      WebContentsView  → API client UI   (overlay, API mode) │
│   ├─ proxyPanel    WebContentsView  → Proxy/Repeater UI (overlay)        │
│   └─ settings      WebContentsView  → settings overlay                   │
│                                                                          │
│  Engines (all in main):                                                  │
│   • TabManager        tabs.ts     — Bro's tab engine (unchanged)         │
│   • HttpEngine        http.ts     — undici-based sender (API + Repeater)  │
│   • InterceptProxy    proxy.ts    — mockttp MITM, history, intercept queue │
│   • ExchangeStore     store.ts    — TOML collections, env, history (disk) │
│   • Vault             vault.ts    — safeStorage-encrypted secrets         │
│   • one shared Electron `session` (persist:default) used by tabs + engines │
│                                                                          │
│  globalShortcut hotkeys → IPC → the right surface                        │
└───────────────▲───────────────────────────────────────┬────────────────┘
                │ contextBridge (preload/bridge.ts)       │ typed IPC
┌───────────────┴───── UI renderers (one per view) ───────┴───────────────┐
│ chrome: tab strip · omnibox · MODE SWITCH · opacity · capture pill       │
│ apiPanel: collection tree · request builder · response + diff · env bar  │
│ proxyPanel: HTTP history table · interceptor · Repeater · scope/rules    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Surfaces are overlays, not windows.** `apiPanel`/`proxyPanel`/`settings` are
`WebContentsView`s layered over the tab region, shown/hidden by the mode switch
(same mechanism Bro already uses for `settings`). Staying inside the single
`BrowserWindow` is what keeps `setContentProtection`/`setOpacity` covering
*everything* — the API client and proxy UI are invisible to screen share too.

---

## 3. The shared model: `HttpExchange` (the glue)

Every surface speaks one record. Defined once in `src/shared/http-model.ts`.

```ts
interface HttpExchange {
  id: string;                 // uuid
  origin: 'browse' | 'api' | 'repeater' | 'proxy';
  request: {
    method: string;
    url: string;
    headers: [string, string][];   // ordered, duplicates allowed (Burp fidelity)
    body?: { kind: 'text' | 'json' | 'form' | 'binary'; text?: string; b64?: string };
  };
  response?: {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: { b64: string; truncatedBytes?: number };   // raw bytes, decode on view
    timingMs: number;
    fromCache?: boolean;
  };
  meta: { startedAt: number; host: string; scheme: 'http' | 'https'; notes?: string };
}
```

Actions defined on an exchange (`src/shared/exchange-actions.ts`), available from
every surface's context menu:

- `sendToRepeater(ex)` → opens Proxy surface, Repeater tab, request pre-filled.
- `saveToCollection(ex, path)` → serializes into a collection request (§5.3).
- `openInTab(ex)` → `tabs.newTab(ex.request.url)` (GET only; body-bearing verbs
  open a rendered response view instead).
- `copyAs(ex, 'curl' | 'fetch' | 'powershell')` → clipboard, via main.
- `replay(ex, session)` → `HttpEngine.send()` through the shared session.

Keeping headers as an **ordered array with duplicates** (not a `Record`) is
deliberate: header order and repeats (`Set-Cookie`, multiple `Via`) are exactly
what a Burp user needs to see faithfully. Never normalize into an object.

---

## 4. Surface 1 — Browse (inherited from Bro)

> **Status: ported in full from Bro** (2026-10-14) — see README → Features.

Bro's whole browser is core: `tabs.ts` (isolated WebContentsView tabs, private
tabs on an in-memory session, sleeping restored tabs, Library tabs `bro://…`),
`profiles.ts` (one persistent session per profile), `library.ts`/`sessions.ts`,
`downloads.ts` + `torrents.ts`, `offline.ts` + `video-tools.ts` +
`stream-grabber.ts`, `extensions.ts`, `context-menu.ts`, `shortcuts.ts` +
`commands.ts` (rebindable registry in `shared/shortcuts.ts`). The default
profile's tabs use the **shared session** the proxy and API engines also use, so a
logged-in session is visible to all three.

Plugin seams added for the port: `MainContext.onSession` (adblock attaches to
every browsing session), `onWindow`, `onStarted`; registry commands tagged
`plugin` (capture/opacity keys exist only with their plugin); plugin preloads
(`src/plugins/<id>/preload.ts`). Tab activation or toolbar navigation returns to
the Browse surface.

Carried-over signature features (window.ts): `setContentProtection(true)` default
ON, opacity floor `0.2`, hotkeys. The mode switch lives in the existing chrome
view, so switching to API/Proxy is instant and stays within the protected window.

---

## 5. Surface 2 — API client (Postman-class)

> **Status: implemented (Postman-class, 2026-10-15).** Code lives in the
> `api-client` plugin (`src/plugins/api-client/`): `engine.ts` (undici sender:
> redirects hop by hop, TLS toggle, timeout, the BROWSER cookie jar, optional
> upstream = the Proxy plugin via `ctx.lookup('proxy')`), `resolve.ts` (draft →
> vars → auth inheritance → body encoding → `${vault:}`/`${env:}` expansion),
> `sandbox.ts` (pre-request/test scripts, `pm.*`, in QuickJS-wasm with a 3 s /
> 64 MB cap — not Node `vm`), `runner.ts` (send pipeline + collection runner +
> OAuth 2 token), `vault.ts` (safeStorage), `interop.ts` (Postman/OpenAPI/cURL
> import, Postman export, CSV/JSON data files), `store.ts` (TOML collections,
> environments, globals, hot-reload watcher, JSON history), `main.ts` (IPC),
> `ui/panel.{html,ts,css}`. Expanded secrets are never written to history. The paths below that say `src/main/*` are the
> original monolith sketch; the plugin refactor (§A) is the shipped layout.

### 5.1 Engine — `src/main/http.ts` (`HttpEngine`)

A thin wrapper over **undici** (`request`) running in main. Responsibilities:

- Send an `HttpExchange.request` and fill `.response` with raw bytes + timing.
- No CORS, arbitrary headers/methods (that's the Postman value: it's not a page).
- Reuse the shared Electron `session` cookie jar when `useBrowserSession` is on,
  else an isolated per-environment jar.
- Route through the **InterceptProxy** when "fire through proxy" is on, so an API
  send shows up in the proxy history exactly like browser traffic.
- Streaming + a hard body cap (default 10 MB, configurable) so a huge response
  can't OOM the UI; overflow recorded in `truncatedBytes`.
- Redirect policy, timeout, retry — all explicit, all surfaced in the UI.

### 5.2 Variables, environments, secrets

- **Environments** are named maps of variables (`baseUrl`, `token`, …), stored as
  TOML (§5.3). An env bar in the UI picks the active one.
- **Substitution**: `{{var}}` in URL/headers/body resolves against (request vars →
  active env → globals). Resolution is pure and testable (`src/shared/vars.ts`).
- **Secrets never sit in collection files.** A secret value is a reference:
  `${vault:prod/token}` or `${env:CI_TOKEN}`. The Vault (§8.3) resolves `vault:`
  refs at send time via `safeStorage`; `env:` reads `process.env`. This is lifted
  straight from OpsPilot's §12 rule ("identities → vault refs. NO secrets").

### 5.3 Persistence — portable TOML collections (`ExchangeStore`, `store.ts`)

Config-as-source-of-truth, mirroring OpsPilot §12. Under Electron `userData`
(overridable by `BRO_PLUS_CONFIG_DIR` for a portable USB install):

```
<config>/
  api/
    collections/
      my-service.toml        # a tree of folders + requests
      auth.toml
    environments/
      production.toml
      local.toml
    globals.toml
  proxy/
    scope.toml               # include/exclude host rules
    rules.toml               # match/replace, auto-modify
    history.db               # SQLite ring buffer of exchanges (derived, large)
  vault.bin                  # encrypted secrets (safeStorage)
  settings.toml
```

Collection file shape (human-diffable, git-friendly — the Postman-vs-Bruno win):

```toml
# api/collections/my-service.toml
name = "My Service"

[[folder]]
name = "Auth"
  [[folder.request]]
  name = "Login"
  method = "POST"
  url = "{{baseUrl}}/auth/login"
  headers = [["Content-Type", "application/json"]]
  body.kind = "json"
  body.text = '''{ "user": "{{user}}", "pass": "${vault:prod/pass}" }'''

[[request]]
name = "Health"
method = "GET"
url = "{{baseUrl}}/health"
```

Rules (all from OpsPilot §12.2): **TOML not YAML**; **no absolute paths**; **atomic
write** (temp → fsync → rename); `schema_version` with forward migration;
**hot-reload** via a dir watcher so editing a collection in an editor updates the
tree live. `history.db` is the one SQLite exception — it's a large, derived ring
buffer, never source of truth.

### 5.4 Request builder & response viewer (UI — `src/ui/api.*`)

- Builder: method + URL + tabs for Params / Headers / Auth / Body
  (raw/json/form/multipart) / Pre-request & Test scripts.
- Response: pretty JSON (collapsible) · raw · headers · cookies · timing
  waterfall · size. **Diff mode** compares the current response to the previous
  send of the same request (or any two history entries) — a real OpsPilot feature
  ("response viewer with a diff mode"), great for regression spotting.
- Scripts (optional, later phase): pre-request and test scripts run in a **locked
  V8 sandbox** (Node `vm` with a tiny `pm`-like API; no `require`, no fs, no net
  except a provided helper). Treat script code as untrusted. If sandbox hardening
  is in doubt, ship with scripts disabled rather than a leaky `vm`.

---

## 6. Surface 3 — Intercepting proxy (Burp-class)

> **Status: implemented.** Code lives in the `proxy` plugin
> (`src/plugins/proxy/`): `engine.ts` (`ProxyEngine` on mockttp — CA, MITM,
> history, intercept hold, Repeater, scope), `main.ts` (IPC), `ui/panel.{html,ts}`
> (history table + detail, live intercept editor, Repeater). Per-session CA trust
> via `setCertificateVerifyProc`; OS-trust install + match/replace rules remain
> (ROADMAP Phase 5). Paths below naming `src/main/proxy.ts` are the original
> sketch; the shipped path is `src/plugins/proxy/engine.ts`.

### 6.1 Engine — `src/main/proxy.ts` (`InterceptProxy`), built on **mockttp**

`mockttp` gives us, out of the box: a local HTTP/HTTPS proxy, **on-the-fly CA +
per-host leaf cert generation** for TLS MITM, and a rule/event API to observe and
rewrite traffic. We wrap it, we don't reinvent a TLS stack.

Flow:

1. On enable, `InterceptProxy` starts mockttp on a free localhost port and loads
   (or generates once) a root CA stored in the vault.
2. The browsing `session` is pointed at it: `ses.setProxy({ proxyRules:
   '127.0.0.1:<port>' })`. **Trust without touching the OS store**:
   `ses.setCertificateVerifyProc()` accepts the proxy's MITM leaf certs for
   in-browser traffic — so the browser trusts our CA *only inside Bro_plus*, not
   system-wide. (Capturing *other* apps' traffic is a later, opt-in mode that
   does require installing the CA in the OS store — gated and explained in §8.)
3. Every request/response pair becomes an `HttpExchange` (`origin: 'proxy'`),
   appended to the history ring buffer and streamed to the proxy UI.

### 6.2 Intercept / modify (the Burp "Intercept" tab)

- A toggle puts matching requests (by scope, §6.4) into a **hold queue** before
  they go upstream. The paused exchange is editable in the UI (method, URL,
  headers, body); Forward sends the edited version, Drop kills it.
- Same optional hold on responses (edit a response before the page sees it).
- Implemented with mockttp's async `beforeRequest`/`beforeResponse` callbacks that
  `await` a promise the UI resolves on Forward/Drop. A hard timeout auto-forwards
  so a forgotten intercept can't wedge browsing.

### 6.3 Repeater

A list of editable exchanges you resend with one click, each keeping its own
response history so you can **diff** across sends (reuses §5.4's diff). "Send to
Repeater" from any surface drops an exchange here. This is the single most-used
Burp feature and the clearest bridge to the API client — a Repeater item is one
"Save to Collection" away from being a permanent API request.

### 6.4 Scope & rules (`proxy/scope.toml`, `proxy/rules.toml`)

- **Scope**: include/exclude by host glob / regex. Out-of-scope traffic is passed
  through untouched and (optionally) not even logged — essential for signal and
  for not capturing unrelated sites.
- **Match/replace rules**: rewrite headers/body on the fly (e.g. inject a header,
  swap a host). Declarative in TOML, hot-reloaded.

### 6.5 What this is **not**

No Intruder-style fuzzer/brute-forcer, no automated attack tooling, no scanner in
v1. This is a developer/debugging + authorized-testing instrument: observe,
modify, replay *your own* traffic. (See §8.4.)

---

## 7. Interop — how the three surfaces share

| From → To | Mechanism |
|---|---|
| Browse → Proxy | all tab traffic flows through the proxy; appears in history |
| Proxy → Repeater | `sendToRepeater(ex)` |
| Proxy/Repeater → API | `saveToCollection(ex, path)` turns a live request into a saved one |
| API → Proxy | "fire through proxy" routes `HttpEngine.send` via the proxy |
| API/Repeater → Browse | `openInTab` / rendered response view |
| any → clipboard | `copyAs(curl\|fetch\|powershell)` |
| shared auth | one Electron `session` → cookies/tokens visible to all three |

The shared `session` is the keystone. Everything else is a transform over the one
`HttpExchange` record.

---

## 8. Security & trust model (read before building §6)

### 8.1 The two signature features still hold
`setContentProtection(true)` and `setOpacity()` cover the API and proxy UIs too,
because they're views inside the one window. A password in the API client or a
token in the proxy history is as hidden from screen share as a browser tab.

### 8.2 The MITM CA is the sharpest edge
- The CA private key lives **in the vault** (`safeStorage`/DPAPI), never in a
  config file, never in git. Generated per-install; never shipped.
- **Default scope is in-app only**: `setCertificateVerifyProc` trusts our leaf
  certs *for Bro_plus's session alone*. Nothing else on the machine trusts the CA.
- **System-wide capture** (other apps' traffic) requires explicitly installing the
  CA into the OS/user trust store — a separate, clearly-labelled, reversible
  action with an "uninstall CA" button. Off by default. On managed/Enterprise
  machines, say plainly that this may violate policy and should be IT-approved.
- Provide **CA export + one-click removal**, and regenerate on demand.

### 8.3 Vault — `src/main/vault.ts`
`safeStorage.encryptString` (DPAPI on Windows / Keychain on macOS), same pattern
as AI-App. Holds: the CA key, API secrets (`vault:` refs), saved request auth.
`vault.bin` is portable but useless without the OS user's keychain.

### 8.4 Ethics / legal / scope gating (ship this, don't hide it)
- The proxy decrypts **your own** TLS traffic for debugging and **authorized**
  testing. Intercepting traffic you are not authorized to (someone else's account,
  a service without permission) is unlawful in many places.
- Enforce **scope** by default (§6.4) so the tool doesn't silently capture
  unrelated hosts. First-run notice spells out the consent/authorization rule.
- No attack automation (§6.5). This keeps Bro_plus a dev + authorized-pentest
  tool, not a weapon.

### 8.5 Renderer stays sandboxed
Web content gets no preload and no Node. Only the chrome/api/proxy/settings views
get the typed `bridge.ts`. Script execution (§5.4) is sandboxed or off. Proxy
history bodies are rendered as **inert text** (escaped), never eval'd/executed.

---

## 9. Repo layout (Bro_plus)

```
Bro_plus/
├─ package.json            # + undici, mockttp, @iarna/toml, better-sqlite3, uuid
├─ esbuild.mjs             # Bro's build, extended with api/proxy UI entry points
├─ tsconfig.json
├─ ARCHITECTURE.md         # this file
├─ ROADMAP.md              # the phased build plan
├─ src/
│  ├─ main/
│  │  ├─ index.ts          # app lifecycle (from Bro)
│  │  ├─ window.ts         # signature features (from Bro)
│  │  ├─ browser.ts        # assembles chrome + tabs + API/Proxy/settings overlays
│  │  ├─ tabs.ts           # tab engine (from Bro)
│  │  ├─ shortcuts.ts      # + hotkeys for mode switch, intercept toggle
│  │  ├─ ipc.ts            # + API/Proxy/store channels
│  │  ├─ session.ts        # NEW: the one shared Electron session + proxy wiring
│  │  ├─ http.ts           # NEW: HttpEngine (undici sender)
│  │  ├─ proxy.ts          # NEW: InterceptProxy (mockttp MITM, history, intercept)
│  │  ├─ store.ts          # NEW: ExchangeStore (TOML collections/env, SQLite history)
│  │  └─ vault.ts          # NEW: safeStorage secrets + CA key
│  ├─ preload/
│  │  └─ bridge.ts         # + api/proxy/store surface on window.bro
│  ├─ shared/
│  │  ├─ ipc-contract.ts   # Channels/Events/BroApi (extended)
│  │  ├─ http-model.ts     # NEW: HttpExchange + collection/env types
│  │  ├─ exchange-actions.ts # NEW: sendToRepeater/saveToCollection/copyAs/…
│  │  └─ vars.ts           # NEW: {{var}} / ${vault:}/${env:} resolver (pure)
│  └─ ui/
│     ├─ index.html/.ts    # chrome: tab strip + omnibox + MODE SWITCH (from Bro, extended)
│     ├─ api.html/.ts      # NEW: API client surface
│     ├─ proxy.html/.ts    # NEW: proxy/history/repeater surface
│     ├─ settings.html/.ts # from Bro
│     ├─ start.html        # from Bro
│     └─ styles.css        # shared tokens (from Bro)
└─ build/                  # icons
```

---

## 10. IPC contract additions (`ipc-contract.ts`)

New channels (renderer → main) grouped by surface. All payloads typed in
`http-model.ts`. Highlights:

- Mode: `mode:set` (`'browse'|'api'|'proxy'`), event `evt:mode-changed`.
- API: `api:send` (invoke → `HttpExchange`), `api:collections` (invoke → tree),
  `api:save-request`, `api:env-list`, `api:env-set-active`, `api:resolve-vars`.
- Proxy: `proxy:start`/`proxy:stop`, `proxy:intercept-set` (on/off),
  `proxy:forward`/`proxy:drop` (payload: edited exchange), `proxy:history`
  (invoke/stream), `proxy:scope-set`, `proxy:repeater-add`, `proxy:ca-export`,
  `proxy:ca-install`/`proxy:ca-uninstall`.
- Store/vault: `store:read`, `store:write`, `vault:set`, `vault:has`.
- Events (main → renderer): `evt:proxy-exchange` (new history row),
  `evt:intercept-paused` (an exchange awaiting forward/drop), `evt:collections-changed`
  (hot-reload fired).

Rule (from Bro): add every channel in **three** places — `ipc.ts` handler,
`bridge.ts` wrapper, the calling UI — and type it in `http-model.ts`.

---

## 11. Dependencies (minimal, all mature)

| Dep | Role |
|---|---|
| `electron` 32+ | engine (from Bro) |
| `esbuild`, `typescript` | build (from Bro) |
| `undici` | API/Repeater HTTP sender (Node's own HTTP client) |
| `mockttp` | HTTPS MITM proxy + CA + intercept rule/event API |
| `@iarna/toml` | read/write portable TOML collections & config |
| `better-sqlite3` | proxy history ring buffer (fast, synchronous, local) |
| `uuid` | exchange ids |

`mockttp` and `better-sqlite3` have native/binary parts — pin versions and verify
`npm install` on the target machine early (Phase 2 gate).

---

## 12. Roadmap

See `ROADMAP.md`. In one line: **Phase 0** scaffold + browser runs; **Phase 1**
API client sends a request end-to-end; **Phase 2** proxy captures HTTPS into
history; **Phase 3** intercept + Repeater + send-to glue; **Phase 4** collections/
env/vault persistence + diff; **Phase 5** scope/rules, CA management, packaging.

---

## 13. Risks & limits (don't paper over)

- **Native deps** (`mockttp`, `better-sqlite3`) must build/install on the target;
  gate early. If `better-sqlite3` is painful, history can fall back to an in-memory
  ring + JSONL append.
- **TLS pinning / HSTS**: apps/sites that pin certs won't MITM — expected; show a
  clear "pinned, not intercepted" row rather than failing silently.
- **HTTP/2 & gRPC**: mockttp handles h2; binary gRPC bodies render as hex, not
  pretty JSON. Note it.
- **System-wide CA install** is powerful and risky (§8.2/§8.4) — keep it opt-in,
  reversible, and policy-aware on Enterprise.
- **Script sandbox** (§5.4) is the classic foot-gun; ship disabled if unsure.
- **Capture exclusion is software-only** (Bro's limit) — a camera still sees the
  screen; it is not DRM.
- **Memory**: big response bodies and long proxy history — enforce the body cap
  and the ring-buffer size; stream, don't materialize.
```
