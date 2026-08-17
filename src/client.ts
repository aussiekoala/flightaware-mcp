import {
  readEnvVar,
  readTtlMsEnv,
  createApiClient,
  createResponseCache,
  formatApiError,
  McpToolError,
  type ApiClient,
  type ResponseCache,
} from '@chrischall/mcp-utils';
import { envSource } from './runtime.js';

// NOTE: `.env` loading lives in the Node entrypoint (src/index.ts), not here.
// This module is also imported by the Cloudflare Worker entrypoint, where
// top-level I/O is forbidden and config arrives as request-scoped bindings.

const BASE_URL = 'https://aeroapi.flightaware.com/aeroapi';
const SERVICE = 'FlightAware AeroAPI';
// AeroAPI is billed per query and the free Personal tier is small; keep the
// default abort budget conservative. Most calls return in well under 30s.
const REQUEST_TIMEOUT_MS = 30_000;
// AeroAPI bills per query, so identical GETs in quick succession are wasteful.
// A short-TTL response cache dedupes them. Default 15s — long enough to absorb
// an agent re-reading the same board/flight, short enough that live positions
// aren't dangerously stale. Override with AEROAPI_CACHE_TTL (seconds; 0 = off).
const DEFAULT_CACHE_TTL_MS = 15_000;
// Reference data (airport/operator metadata, popular routes, aircraft owner,
// canonical id mappings) barely changes, so it gets a much longer default TTL —
// 1 hour — keyed off the same cache. Override with AEROAPI_STATIC_CACHE_TTL
// (seconds; 0 = off). Tools opt into this tier via get(path, { cache: 'static' }).
const DEFAULT_STATIC_CACHE_TTL_MS = 3_600_000;

/** Result of a mutating call: parsed body (if any) plus the new-resource id
 * AeroAPI returns in the `Location` header on create. */
export interface WriteResult<T = unknown> {
  status: number;
  /** Trailing path segment of the `Location` header (e.g. the new alert id). */
  locationId?: string;
  data?: T;
}

/** Constructor knobs. Every one of them defaults to an env-derived value. */
export interface FlightAwareClientOptions {
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  staticCacheTtlMs?: number;
  now?: () => number;
}

/** The cache + API client, built on first use (see {@link FlightAwareClient.wired}). */
interface Wiring {
  api: ApiClient;
  cache: ResponseCache;
}

export class FlightAwareClient {
  private readonly opts: FlightAwareClientOptions;
  private readonly fetchImpl: typeof fetch;
  private wiring: Wiring | null = null;

  /**
   * The constructor reads NOTHING from the environment — it just records the
   * overrides. Config is resolved on first use so that (a) the server still
   * boots and answers the host's install-time tools/list probe without
   * AEROAPI_API_KEY, and (b) the Cloudflare Worker build works at all: a
   * Worker's secrets don't exist at module-evaluation time, only once a request
   * hands them to `fetch()` (see src/runtime.ts).
   */
  constructor(opts: FlightAwareClientOptions = {}) {
    this.opts = opts;
    // Wrapped rather than aliased: an unbound global `fetch` is not portable
    // across runtimes.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * Build (once) the response cache and API client. TTLs are read here rather
   * than in the constructor so the Worker's request-scoped env is in place.
   */
  private wired(): Wiring {
    if (this.wiring) return this.wiring;
    const env = envSource();
    const now = this.opts.now ?? Date.now;
    const cacheTtlMs = this.opts.cacheTtlMs ?? readTtlMsEnv('AEROAPI_CACHE_TTL', DEFAULT_CACHE_TTL_MS, { env });
    const staticCacheTtlMs =
      this.opts.staticCacheTtlMs ?? readTtlMsEnv('AEROAPI_STATIC_CACHE_TTL', DEFAULT_STATIC_CACHE_TTL_MS, { env });
    const cache = createResponseCache({ ttlMs: { dynamic: cacheTtlMs, static: staticCacheTtlMs }, now });
    // AeroAPI authenticates with the `x-apikey` header (NOT Authorization:
    // Bearer), so we pass tokenHeader. getToken defers the config error to
    // request time. retry once on 429; on* handlers keep actionable messages.
    const api = createApiClient({
      baseUrl: BASE_URL,
      serviceName: SERVICE,
      tokenHeader: 'x-apikey',
      getToken: () => this.requireKey(),
      timeout: REQUEST_TIMEOUT_MS,
      retry: { count: 1, delayMs: 1000 },
      fetchImpl: this.fetchImpl,
      // AeroAPI returns 401 for BOTH an invalid key AND a valid key hitting an
      // endpoint above its subscription tier (alerts and historical data need
      // the Standard/Premium tier — the free Personal tier 401s them with a
      // "tier" detail). onUnauthorized can't see the body, so the message names
      // both causes rather than falsely asserting the key is bad.
      onUnauthorized: () =>
        new McpToolError(
          'AeroAPI returned 401 Unauthorized — either AEROAPI_API_KEY is invalid, or this endpoint requires a higher subscription tier (Alerts and historical data need the Standard or Premium tier; the free Personal tier does not include them).',
          { hint: 'Check your key and plan at https://www.flightaware.com/aeroapi/portal/' },
        ),
      onRateLimited: () =>
        new McpToolError('Rate limited by AeroAPI', {
          hint: 'AeroAPI bills per query and rate-limits each tier — space out calls or check your usage in the portal.',
        }),
    });
    this.wiring = { api, cache };
    return this.wiring;
  }

  /**
   * Read the key at request time. Deliberately NOT memoised: a Worker isolate
   * that took its first request before the secret was uploaded must pick the
   * key up on the next one rather than serving a cached config error forever.
   */
  private requireKey(): string {
    const key = readEnvVar('AEROAPI_API_KEY', { env: envSource() });
    if (!key) {
      throw new McpToolError('AEROAPI_API_KEY environment variable is required', {
        hint: 'Create an AeroAPI key at https://www.flightaware.com/aeroapi/portal/ and set AEROAPI_API_KEY in your MCP host env or .env (free Personal tier is fine to start). On Cloudflare: `wrangler secret put AEROAPI_API_KEY`.',
      });
    }
    return key;
  }

  /**
   * GET a JSON resource. `path` must already include any query string. Results
   * are served from an in-memory cache (keyed by the full path) to cut repeated
   * per-query billing. `cache: 'static'` selects the longer reference-data TTL
   * (AEROAPI_STATIC_CACHE_TTL) for metadata that barely changes; the default
   * 'dynamic' tier (AEROAPI_CACHE_TTL) is for live data.
   */
  async get<T = unknown>(path: string, opts: { cache?: 'dynamic' | 'static' } = {}): Promise<T> {
    const { api, cache } = this.wired();
    const tier = opts.cache === 'static' ? 'static' : 'dynamic';
    return cache.fetchThrough(path, () => api.fetchJson<T>('GET', path), tier) as Promise<T>;
  }

  /**
   * Mutating call (POST/PUT/DELETE). Routed through raw fetch (not fetchJson)
   * because AeroAPI returns the new-resource id in the `Location` header on
   * create and an empty body on delete — neither fits a JSON-only client.
   * Auth (x-apikey) is attached centrally here so no tool builds it by hand.
   */
  async write<T = unknown>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<WriteResult<T>> {
    const key = this.requireKey();
    const headers: Record<string, string> = { 'x-apikey': key };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      payload = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${BASE_URL}${path}`, { method, headers, body: payload });
    const text = await res.text();
    if (!res.ok) {
      throw new McpToolError(formatApiError(res.status, method, path, text, { service: SERVICE }));
    }
    const location = res.headers.get('location') ?? undefined;
    const locationId = location ? location.split('/').filter(Boolean).pop() : undefined;
    let data: T | undefined;
    if (text.trim()) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        // Some mutations reply with a non-JSON body; surface it verbatim.
        data = text as unknown as T;
      }
    }
    return { status: res.status, locationId, data };
  }
}

/**
 * Module-level singleton shared by every tool module. Constructed here (not in
 * index.ts) so the deferred-config-error pattern holds: the server boots and
 * lists tools even without a key — the error surfaces on the first tool call.
 */
export const client = new FlightAwareClient();
