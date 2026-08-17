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

Get a key at [flightaware.com/aeroapi/portal](https://www.flightaware.com/aeroapi/portal/). The free **Personal** tier (500 calls/month) is enough to start; AeroAPI bills per query.

## Tools

| Area | Tools |
| --- | --- |
| Flights | `fa_get_flights`, `fa_search_flights`, `fa_search_flights_advanced`, `fa_search_flight_positions`, `fa_count_flights`, `fa_get_flight_track`, `fa_get_flight_position`, `fa_get_flight_route`, `fa_get_flight_map`, `fa_get_flight_history`, `fa_resolve_flight` |
| Airports | `fa_get_airport`, `fa_get_airport_flights`, `fa_get_airport_flight_counts`, `fa_get_airport_routes`, `fa_list_airports`, `fa_get_nearby_airports`, `fa_get_airport_delays`, `fa_get_airport_weather`, `fa_resolve_airport` |
| Operators / aircraft | `fa_get_operator`, `fa_get_operator_flights`, `fa_list_operators`, `fa_get_aircraft_owner` |
| Schedules / predictive | `fa_get_scheduled_flights`, `fa_foresight_search` (premium tier) |
| Alerts | `fa_list_alerts`, `fa_get_alert`, `fa_create_alert`, `fa_update_alert`, `fa_delete_alert`, `fa_get_alerts_endpoint`, `fa_set_alerts_endpoint` |

Alert mutations are **confirm-gated**: without `confirm: true` they return a dry-run preview and make no network call.

## Configuration

| Var | Required | Purpose |
| --- | --- | --- |
| `AEROAPI_API_KEY` | yes | Your AeroAPI key (sent as the `x-apikey` header). |
| `AEROAPI_OUTPUT_DIR` | no | Default directory for flight-map PNGs (default: cwd). |
| `AEROAPI_CACHE_TTL` | no | Seconds to cache identical **live-data** GET responses (default: 15; `0` disables). Cuts AeroAPI per-query billing. |
| `AEROAPI_STATIC_CACHE_TTL` | no | Longer TTL for **reference data** — airport/operator info, routes, ownership, canonical lookups (default: 3600; `0` disables). |

## Hosting on Cloudflare Workers

The same 33 tools are served over MCP Streamable HTTP at `POST /mcp` by `src/worker.ts`. The deployment is **stateless** — each request builds its own server and transport, so no Durable Objects or KV are needed.

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
