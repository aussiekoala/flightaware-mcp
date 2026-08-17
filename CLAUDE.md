# CLAUDE.md — flightaware-mcp

Guidance for Claude working in this repo.

## TL;DR

**FlightAware AeroAPI** (v4) MCP server. Wraps the AeroAPI REST API
(`https://aeroapi.flightaware.com/aeroapi`) and exposes 34 tools to Claude over
stdio: flight lookup/search/positions/count/track/position/route/map/history/
canonical, airport boards + counts + routes + delays + weather + nearby +
canonical, operators, aircraft owner, scheduled flights, Foresight predictive
search, and flight-alert management.

Ships **two entrypoints over one tool roster**: `src/index.ts` (Node, stdio) and
`src/worker.ts` (Cloudflare Workers, Streamable HTTP at `POST /mcp`). Both pull
from `src/registrars.ts`, so a new tool module is wired into both by editing one
list.

Auth is an AeroAPI key (`AEROAPI_API_KEY`) sent in the **`x-apikey`** header —
AeroAPI does **not** use `Authorization: Bearer`. This is the bearer/direct-API
archetype: reads go through the fleet-shared `createApiClient` (configured with
a non-Bearer `tokenHeader`); mutations go through a small raw-`fetch` `write()`
because AeroAPI returns the new-resource id in the `Location` header on create
and an empty body on delete (neither fits a JSON-only client). No fetchproxy.

## Environment

```
AEROAPI_API_KEY=<key>            # Required. Create at https://www.flightaware.com/aeroapi/portal/
MCP_AUTH_TOKEN=<token>          # Worker only. Bearer token callers must present; no token = 503
MCP_ALLOW_ANONYMOUS=true        # Worker only. Opt out of the bearer gate (discouraged)
AEROAPI_OUTPUT_DIR=<dir>         # Optional, Node only. Flight-map PNG dir (default: cwd)
AEROAPI_CACHE_TTL=<secs>        # Optional. Live-data read-cache TTL (default 15; 0 disables)
AEROAPI_STATIC_CACHE_TTL=<secs> # Optional. Reference-data read-cache TTL (default 3600; 0 disables)
AEROAPI_USAGE_FOOTER=false      # Optional. Turn off the per-result spend line (default on)
AEROAPI_USAGE_TTL=<secs>        # Optional. Usage-reading memo TTL (default 300)
AEROAPI_FREE_CREDIT=<usd>       # Optional. Monthly credit the footer measures against (default 5)
AEROAPI_SPEND_LIMIT=<usd>       # Optional. Hard ceiling — tools refuse at/over it. Unset = report only
AEROAPI_ALLOW_UNVERIFIED_SPEND=true # Optional. Don't fail closed when spend is unreadable
```

`client.get(path, { cache })` is backed by an in-memory cache keyed by full
path, with two TTL tiers to cut AeroAPI's per-query billing: **dynamic**
(`AEROAPI_CACHE_TTL`, default 15s) for live data, and **static**
(`AEROAPI_STATIC_CACHE_TTL`, default 3600s) for reference data that barely
changes — opted in per tool via `get(path, { cache: 'static' })` (airport/
operator info, `fa_list_*`, routes, aircraft owner, `fa_resolve_*`). Writes are
never cached. Tier note: alerts, `fa_get_flight_history`, and the `fa_resolve_*`
canonical tools require a Standard/Premium tier (Personal 401s).

Loaded via `loadDotenvSafely` from `.env` next to `dist/` **in `src/index.ts`
only** (failure swallowed — the .mcpb bundle has no dotenv). It cannot live in
`client.ts`: the Worker shares that module and forbids top-level I/O.

The config error is **deferred**: the server boots without a key and the
actionable error surfaces on the first tool call, so the host's install-time
`tools/list` probe still succeeds. `FlightAwareClient`'s constructor therefore
reads **nothing** from the environment — TTLs resolve on first use, and the key
resolves on *every* call (a Worker isolate whose first request predated
`wrangler secret put` must not cache the failure forever).

### Cloudflare Workers

`src/worker.ts` + `wrangler.toml`. Deployed by **Cloudflare Workers Builds** (repo
connected in the CF dashboard; pushes to the production branch auto-deploy);
`npm run deploy` is the manual path. Wrangler compiles `src/worker.ts` itself, so
there is no separate worker build step.

- **Stateless**: a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport`
  per request, `enableJsonResponse: true`, no sessions → no Durable Objects. The
  JSON-response mode is what makes tearing the server down right after
  `handleRequest` safe (the body is fully materialised, not a live stream).
- **Fails closed**: `/mcp` needs `Authorization: Bearer $MCP_AUTH_TOKEN`; with no
  token configured it 503s rather than serving openly, because AeroAPI bills per
  query. `MCP_ALLOW_ANONYMOUS=true` overrides. `?token=` is accepted as a
  documented-lesser fallback (header wins) purely because hosted connector UIs
  assume OAuth and can't attach a static header — it leaks the token into request
  logs, so don't promote it to the primary path.
- **Worker-only env**: `MCP_AUTH_TOKEN`, `MCP_ALLOW_ANONYMOUS`. Secrets go through
  `wrangler secret put`, never `[vars]` (committed + dashboard-readable).
- `/health` is unauthenticated and reports which secrets landed — the first thing
  to check after a deploy.

## Layout

- `src/registrars.ts` — the shared tool roster + server name/banner. Both
  entrypoints import it; add new tool modules here.
- `src/runtime.ts` — the only place that knows Node and Workers differ: the env
  source (`process.env` vs. request-scoped bindings, installed by `worker.ts`)
  and `hasFilesystem()`.
- `src/client.ts` — `FlightAwareClient` (lazy config; `get()` reads via
  `createApiClient`; `write()` raw fetch for mutations + Location parsing).
- `src/tools/shared.ts` — path-segment guards (`FlightIdent`/`AirportCode`/
  `OperatorCode`/`AlertId`), pagination/date-window schemas, `qs()`, and the
  map-PNG writer (Node-only — guard calls with `hasFilesystem()`).
- `src/usage.ts` — usage reporting **and** the spend gate, off one memoised
  reading. `withUsageGuard` proxies a registrar's `registerTool` so every tool
  checks `AEROAPI_SPEND_LIMIT` before running and appends the spend line after.
  Two rules pull in opposite directions and both matter: with **no** limit set a
  usage failure is swallowed (it must never break a working call), but with a
  limit set an unverifiable spend **fails closed** (an unverifiable budget is not
  a satisfied budget). `fa_get_account_usage` is exempt from the gate so it stays
  reachable while blocked.
- `src/tools/{flights,airports,operators,aircraft,schedules,alerts,account}.ts` —
  each exports `register*Tools(server)`; `index.ts` wires them via `runMcp`.

## Conventions

- **Confirm-gated writes.** Every alert mutation takes `confirm` (`schemaConfirm`).
  Without `confirm: true` it makes NO network call and returns a dry-run preview;
  with it, the call routes through `client.write()`.
- **Path-injection guards.** `ident`/`id`/codes are interpolated into the URL
  path, so their zod schemas restrict the charset (see `shared.ts`).
- **Verify before trusting a shape.** Many response shapes are coded from the
  documented v4 surface and marked **[verify-pending]** in `docs/FLIGHTAWARE-API.md`
  — re-verify against a real 200 (free Personal key) before treating as confirmed.
- **Spend, not call count.** AeroAPI prices per endpoint and the Personal tier
  includes $5/month of credit, so there is no "N calls/month" figure — anything
  claiming one is wrong. Track dollars via `/account/usage`.
- TDD; mock the network in tests. Don't hand-bump the version (release-please).

## Pull requests & release notes

Apply exactly one release-notes label per PR (`enhancement` → Features, `bug` → Bug Fixes, `dependencies` → Dependencies, etc.), and give the PR a Conventional-Commit title — release-please parses the squash subject to pick the version bump and changelog section.

**Exception for first-party dependency bumps.** When bumping a package we own (`@chrischall/mcp-utils`, `@chrischall/realty-core`, `@fetchproxy/server` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching Conventional-Commit prefix (`feat:` or `fix:`) instead of `chore:`/`build(deps):`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).
