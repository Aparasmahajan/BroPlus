# Bro_plus — Roadmap (the "proceed" plan)

A smooth, test-at-every-step path from the working browser base to the full
Browse + API + Proxy tool. Each phase **ends with something runnable** and a
concrete gate you can verify. See `ARCHITECTURE.md` for the design behind each.

Legend: ✅ done · 🟡 partial · ◻ to do.

## Status snapshot

- **Browser parity with Bro** — ✅ done (2026-10-14): every Bro browser feature is in
  core (tabs, private tabs, profiles, Library, downloads + torrents, Save for offline,
  extensions, context menus, rebindable shortcuts, sessions, backup, Widevine via
  castlabs Electron 44, auto-update wiring); adblock is now a real plugin. ◻ remaining:
  route private/profile sessions through the Proxy too (today only the default
  session is proxied), port Bro's e2e suites (tests/e2e) to BroPlus.
- **Phase 0 Foundation** — ✅ done (browser + plugin host + build-time selection).
- **Postman feature set** — ✅ done (2026-10-15): see PLUGINS.md → api-client. ◻ remaining: pm.sendRequest, CryptoJS/xml2Json in scripts, Digest/AWS/NTLM auth, OAuth 2 auth-code + PKCE (needs a browser hop), WebSocket/gRPC requests, mock servers, drag-and-drop reorder in the tree.
- **Phase 1 API client** — ✅ done (builder, params/headers/auth/body, `{{vars}}`,
  environments, collections, response viewer + **diff**, history).
- **Phase 2 Proxy captures HTTPS** — ✅ done (mockttp MITM, per-session CA trust,
  live HTTP history). Verified end-to-end with a proxied request.
- **Phase 3 Intercept + Repeater + glue** — ✅ done (hold/edit/forward/drop,
  Repeater, Send-to-Repeater, Copy as curl). ◻ remaining: "fire an API request
  through the proxy" so API sends also appear in proxy history.
- **Phase 4 Persistence & diff** — 🟡 collections + environments as TOML ✅,
  diff ✅, history as JSON ✅. ◻ remaining: `${vault:}`/`${env:}` secret
  resolution (needs a `vault` plugin), hot-reload watcher, SQLite history.
- **Phase 5 Scope, rules, CA, packaging** — 🟡 scope ✅, CA export ✅.
  ◻ remaining: match/replace rules, OS-trust CA install+uninstall, first-run
  consent notice, electron-builder packaging.

---

## Phase 0 — Foundation runs (scaffold)  ✅/◻

- ✅ Copy the working `Bro` base into `Bro_plus` (browser works day one).
- ✅ `ARCHITECTURE.md`, `ROADMAP.md`.
- ✅ Extend `package.json` with the new deps and build wiring.
- ✅ Add the shared model: `http-model.ts`, `vars.ts`, extended `ipc-contract.ts`.
- ✅ Add a **mode switch** (Browse / API / Proxy) to the chrome and the
     `apiPanel` / `proxyPanel` overlay plumbing in `browser.ts`.
- ✅ Minimal **API surface that really sends a request** (`http.ts` + `api.*`).
- ◻ `npm install` and `npm run start` on the target machine.

**Gate:** `npm start` opens the browser; the mode switch flips to an API panel
that can send `GET https://httpbin.org/get` and show the JSON response.

---

## Phase 1 — API client, usable  ◻

- ◻ Request builder tabs: Params, Headers, Auth (bearer/basic), Body
  (raw/json/form/multipart).
- ◻ Response viewer: pretty JSON (collapsible), raw, headers, cookies, timing.
- ◻ Variable substitution `{{var}}` wired through `vars.ts`; an environment bar.
- ◻ Request history (in-memory first).

**Gate:** build a real request against a local service with `{{baseUrl}}` + a
bearer token from an environment, resend, read the response.

---

## Phase 2 — Proxy captures HTTPS  ◻

- ◻ `session.ts`: the one shared `session`; wire tabs to it.
- ◻ `proxy.ts`: start mockttp, generate+store CA in vault, point the session's
  proxy at it, `setCertificateVerifyProc` to trust leaf certs in-app only.
- ◻ Stream every exchange to a **HTTP history** table in `proxy.*`.

**Gate:** browse an HTTPS site; every request shows in the proxy history with
decrypted headers/body. Pinned sites show a "not intercepted" row, not a crash.

---

## Phase 3 — Intercept + Repeater + the glue  ◻

- ◻ Intercept toggle + hold queue; edit/Forward/Drop a paused request (auto-forward
  timeout so it can't wedge).
- ◻ Repeater: send-to, edit, resend, per-item response history.
- ◻ `exchange-actions.ts`: `sendToRepeater`, `openInTab`, `copyAs(curl|fetch|ps)`.
- ◻ "Fire API request through the proxy" so API sends appear in history.

**Gate:** browse → intercept a request → modify a header → forward → see the
changed response; then send that exchange to Repeater and resend.

---

## Phase 4 — Persistence & diff  ◻

- ◻ `store.ts`: TOML collections + environments, atomic writes, hot-reload watcher.
- ◻ `vault.ts`: `${vault:…}` / `${env:…}` resolution at send time.
- ◻ `saveToCollection(ex)` from proxy/Repeater → a permanent API request.
- ◻ Response **diff mode** (current vs previous send; any two history rows).
- ◻ Proxy history ring buffer in SQLite (or JSONL fallback).

**Gate:** save a captured request into `api/collections/*.toml`, edit the file in
an external editor, watch the tree hot-reload, resend with a vault-stored token,
diff the response against the previous run.

---

## Phase 5 — Scope, rules, CA management, packaging  ◻

- ◻ Scope include/exclude (`scope.toml`); out-of-scope passthrough.
- ◻ Match/replace rules (`rules.toml`), hot-reloaded.
- ◻ CA export / OS-trust install + **one-click uninstall**; opt-in, policy notice.
- ◻ Settings surface for all of the above; first-run consent/authorization notice.
- ◻ `electron-builder` Win (portable + NSIS) & macOS; signing/notarization.

**Gate:** a packaged build; scope limits capture to chosen hosts; CA installs and
fully uninstalls; first-run notice shown.

---

## Build / run (every phase)

```
cd "C:\Users\parmahaj\Documents\New folder\Bro_plus"
npm install          # first time (pulls electron + undici + mockttp + …)
npm run start        # build (esbuild) then launch electron
npm run watch        # rebuild on change (separate terminal), then: electron .
npm run typecheck    # tsc --noEmit — run before every commit
```

**Rule carried from Bro:** a new IPC channel is added in **three** places —
`main/ipc.ts`, `preload/bridge.ts`, the calling UI — and typed in
`shared/http-model.ts` / `ipc-contract.ts`. Keep web content sandboxed (no
preload, no Node); keep the renderer thin.
```
