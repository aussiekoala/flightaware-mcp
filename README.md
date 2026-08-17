# flightaware-mcp

[![npm](https://img.shields.io/npm/v/@chrischall/flightaware-mcp)](https://www.npmjs.com/package/@chrischall/flightaware-mcp)

MCP server for **FlightAware AeroAPI** (v4) — live flight tracking and aviation data for Claude. Track flights, read airport boards, look up operators and aircraft, fetch scheduled flights, and manage flight alerts.

Runs two ways from one codebase: **locally over stdio** (npx/mcpb), or **hosted on Cloudflare Workers** as a remote MCP server over Streamable HTTP.

> Developed and maintained by AI (Claude Code). Use at your own discretion.

## Quick start

```json
{
  "mcpServers": {
    "flightaware": {
      "command": "npx",
      "args": ["-y", "@chrischall/flightaware-mcp"],
      "env": { "AEROAPI_API_KEY": "your-aeroapi-key-here" }
    }
  }
}
```

Get a key at [flightaware.com/aeroapi/portal](https://www.flightaware.com/aeroapi/portal/). AeroAPI bills **per query at per-endpoint rates**, and the **Personal** tier includes **$5/month of free credit** — so what you have left is a dollar figure, not a call count. Every tool result carries a one-line reminder of where you stand (see [Usage and spend](#usage-and-spend)).

## Tools

| Area | Tools |
| --- | --- |
| Flights | `fa_get_flights`, `fa_search_flights`, `fa_search_flights_advanced`, `fa_search_flight_positions`, `fa_count_flights`, `fa_get_flight_track`, `fa_get_flight_position`, `fa_get_flight_route`, `fa_get_flight_map`, `fa_get_flight_history`, `fa_resolve_flight` |
| Airports | `fa_get_airport`, `fa_get_airport_flights`, `fa_get_airport_flight_counts`, `fa_get_airport_routes`, `fa_list_airports`, `fa_get_nearby_airports`, `fa_get_airport_delays`, `fa_get_airport_weather`, `fa_resolve_airport` |
| Operators / aircraft | `fa_get_operator`, `fa_get_operator_flights`, `fa_list_operators`, `fa_get_aircraft_owner` |
| Schedules / predictive | `fa_get_scheduled_flights`, `fa_foresight_search` (premium tier) |
| Alerts | `fa_list_alerts`, `fa_get_alert`, `fa_create_alert`, `fa_update_alert`, `fa_delete_alert`, `fa_get_alerts_endpoint`, `fa_set_alerts_endpoint` |
| Account | `fa_get_account_usage` |

Alert mutations are **confirm-gated**: without `confirm: true` they return a dry-run preview and make no network call.

## Usage and spend

AeroAPI charges per query at rates that differ by endpoint, so the meaningful number is **dollars spent against your monthly credit**, not calls made. Two things surface it:

- **`fa_get_account_usage`** reads `GET /account/usage` on demand, defaulting to the current calendar month — the window the credit resets on.
- **Every other tool result ends with a usage line**, so the balance travels with whatever you were already doing rather than needing a separate question:

  ```
  — AeroAPI usage: $1.23 spent this month · $3.77 of $5.00 credit remaining · 42 queries
  ```

That reading is memoised for `AEROAPI_USAGE_TTL` seconds (default 300), so a burst of tool calls costs at most one extra query per window. If the lookup fails — wrong tier, no key, a blip — the footer is silently omitted and your tool call is unaffected.

### Enforcing a ceiling

Set `AEROAPI_SPEND_LIMIT` (USD) and the reading stops being advisory. Before any tool does its work, the server checks the month's spend; at or over the limit the call is **refused without ever reaching AeroAPI**, so a blocked call costs nothing:

```
AeroAPI spend limit reached: $5.00 spent this month, limit is $5.00. No AeroAPI call was made.
```

The rule is exactly that simple: **under the limit → approved, at or over → declined.** The freshest reading available decides — the live one when the meter answers, the last successful one when it doesn't. If no reading has ever succeeded, calls are approved rather than blocked: the meter is a free endpoint being read every few minutes, so it recovers fast, and a silent meter should not take down the whole server over pennies.

`fa_get_account_usage` is never gated, so you can always ask where you stand.

Two things to understand about the guarantee:

- **Enforcement granularity is the memo window.** Spend is re-read once per `AEROAPI_USAGE_TTL` (default 300s), not once per call, so the ceiling holds to within one window of activity. Shorten the TTL to tighten it, at the cost of more usage queries.
- **This is a client-side gate.** It stops *this server* from spending. Only a cap in the [AeroAPI portal](https://www.flightaware.com/aeroapi/portal/) stops the billing itself — set both if the ceiling really matters.

The `/account/usage` request and response are **pinned against the live API** (see `docs/FLIGHTAWARE-API.md`): the gate reads `total_cost`, the gross figure, and the query window is whole-second datetimes ending a minute ago — AeroAPI 400s a future `end`, reads a bare date as midnight (dropping today), and 500s on fractional seconds.

## Configuration

| Var | Required | Purpose |
| --- | --- | --- |
| `AEROAPI_API_KEY` | yes | Your AeroAPI key (sent as the `x-apikey` header). |
| `AEROAPI_OUTPUT_DIR` | no | Default directory for flight-map PNGs (default: cwd). |
| `AEROAPI_CACHE_TTL` | no | Seconds to cache identical **live-data** GET responses (default: 15; `0` disables). Cuts AeroAPI per-query billing. |
| `AEROAPI_STATIC_CACHE_TTL` | no | Longer TTL for **reference data** — airport/operator info, routes, ownership, canonical lookups (default: 3600; `0` disables). |
| `AEROAPI_USAGE_FOOTER` | no | Append the spend line to every tool result (default: `true`; set `false` to switch off). |
| `AEROAPI_USAGE_TTL` | no | Seconds to reuse a usage reading before spending another query on it (default: 300). |
| `AEROAPI_FREE_CREDIT` | no | Monthly credit in USD the footer measures against (default: `5`, the Personal tier). |
| `AEROAPI_SPEND_LIMIT` | no | Hard ceiling in USD. Unset = reporting only. Set = tool calls are refused at or over this month's spend, before any AeroAPI request is made. |

## Hosting on Cloudflare Workers

The same 34 tools are served over MCP Streamable HTTP at `POST /mcp` by `src/worker.ts`. The deployment is **stateless** — each request builds its own server and transport, so no Durable Objects or KV are needed.

### 1. Set the secrets

```bash
npm install
npx wrangler login                      # once, to link your Cloudflare account

npx wrangler secret put AEROAPI_API_KEY  # paste your AeroAPI key at the prompt
npx wrangler secret put MCP_AUTH_TOKEN   # paste a token: openssl rand -hex 32
```

Both are **secrets**, never `[vars]` — `wrangler.toml` is committed, and `[vars]` are readable from the dashboard. `npm run cf:secrets` runs both prompts back to back.

### 2. Deploy

Deployment is wired through **Cloudflare Workers Builds**: connect this repo in the Cloudflare dashboard (*Workers & Pages → flightaware-mcp → Settings → Builds*), and every push to the production branch builds and deploys from `wrangler.toml`. No GitHub secrets or CI workflow needed — Cloudflare pulls the repo itself.

To deploy by hand (first deploy, or a hotfix): `npm run deploy`.

Verify a deploy without authenticating — `/health` reports whether each secret actually landed:

```bash
curl https://flightaware-mcp.<your-subdomain>.workers.dev/health
# {"status":"ok","version":"0.3.4","endpoint":"/mcp","aeroapi_key":"configured","auth":"bearer", …}
```

### 3. Point a client at it

```json
{
  "mcpServers": {
    "flightaware": {
      "type": "http",
      "url": "https://flightaware-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <your MCP_AUTH_TOKEN>" }
    }
  }
}
```

### Auth, and why it fails closed

AeroAPI bills per query, so a public URL carrying your key is a bill anyone can run up. Every request to `/mcp` must present `Authorization: Bearer <MCP_AUTH_TOKEN>`; anything else gets a `401`. If `MCP_AUTH_TOKEN` is not set at all, the Worker returns `503` and serves nothing rather than defaulting to open — set `MCP_ALLOW_ANONYMOUS=true` to override that, which is only sane behind Cloudflare Access or a private route.

**Clients that can't send headers.** Hosted connector UIs (claude.ai, Claude Desktop) assume a remote MCP server speaks OAuth and give you nowhere to attach a static header. For those, the token may instead ride on the URL:

```
https://flightaware-mcp.<your-subdomain>.workers.dev/mcp?token=<your MCP_AUTH_TOKEN>
```

The header is checked first and remains the preferred path. Understand the trade-off before using the query string: a token in a URL is recorded in Cloudflare's request logs and stored in plaintext by whatever holds the connector config, where an `Authorization` header is not. Rotate with `wrangler secret put MCP_AUTH_TOKEN` and update the URL. If you want the proper fix rather than the pragmatic one, put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the route, or give the Worker a real OAuth provider.

### Local development

```bash
cp .dev.vars.example .dev.vars    # fill in both values; .dev.vars is gitignored
npm run worker:dev                # runs the Worker on http://127.0.0.1:8787 via workerd
```

### Differences from the stdio build

| | stdio | Worker |
| --- | --- | --- |
| Config source | `process.env` + `.env` | request-scoped bindings/secrets |
| `fa_get_flight_map` | writes a PNG, returns the path | returns the image inline (no durable disk) |
| `AEROAPI_OUTPUT_DIR` | honoured | ignored |

## Development

```bash
npm install
npm run build
npm test
```

Every request rides your own AeroAPI key and counts against your subscription quota. See `docs/FLIGHTAWARE-API.md` for the pinned endpoint surface.

## License

MIT
