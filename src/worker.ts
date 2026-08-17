/**
 * Cloudflare Workers entrypoint — the same tool roster as the stdio server
 * (`TOOL_COUNT`), served over MCP Streamable HTTP at `POST /mcp`.
 *
 * Shape: **stateless**. Each request builds its own McpServer + transport, runs
 * one JSON-RPC exchange, and tears them down; no session state survives between
 * requests, so any isolate can serve any request and nothing needs Durable
 * Objects. `enableJsonResponse` keeps POST replies as plain JSON bodies instead
 * of SSE streams, which is what makes that teardown safe (see `handleMcp`).
 *
 * Only POST reaches the transport. `enableJsonResponse` does NOT apply to the
 * transport's GET handler — that always opens an SSE stream with a keep-alive
 * interval — and in stateless mode a server-initiated stream can never carry
 * anything, so it would be a leaked server, transport and timer per connection.
 * GET and DELETE are answered 405 here instead, which is also what the spec
 * prescribes for a server that offers no standalone stream and no sessions.
 *
 * Guarding this endpoint matters more than usual: AeroAPI bills per query, so an
 * unauthenticated public URL is a bill someone else can run up. Requests must
 * present `Authorization: Bearer <MCP_AUTH_TOKEN>`, and a deployment with no
 * token configured refuses to serve at all unless MCP_ALLOW_ANONYMOUS is set.
 */
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { SERVER_NAME, TOOL_COUNT, TOOL_REGISTRARS } from './registrars.js';
import { setEnvSource, setFilesystemAvailable, type EnvSource } from './runtime.js';

/**
 * Worker bindings. `AEROAPI_API_KEY` and `MCP_AUTH_TOKEN` are secrets
 * (`wrangler secret put`), never `[vars]` — vars are readable in the dashboard
 * and committed in wrangler.toml.
 */
export interface WorkerEnv extends EnvSource {
  /** AeroAPI key, sent upstream as `x-apikey`. Secret. */
  AEROAPI_API_KEY?: string;
  /** Shared secret every caller must present as a bearer token. Secret. */
  MCP_AUTH_TOKEN?: string;
  /** Escape hatch: serve without MCP_AUTH_TOKEN. Off unless explicitly set. */
  MCP_ALLOW_ANONYMOUS?: string;
  /** Live-data read-cache TTL in seconds (default 15). */
  AEROAPI_CACHE_TTL?: string;
  /** Reference-data read-cache TTL in seconds (default 3600). */
  AEROAPI_STATIC_CACHE_TTL?: string;
}

/** The MCP endpoint path — what goes in your client's server URL. */
const MCP_PATH = '/mcp';

/**
 * Headers browser-based MCP clients need. `mcp-session-id` is exposed for
 * spec-completeness; this deployment is stateless and never sets it.
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

/**
 * JSON-RPC-shaped error, so an MCP client surfaces the reason rather than an
 * opaque transport failure. Code -32001 matches the SDK's transport-level errors.
 */
function rpcError(status: number, message: string, extra: Record<string, string> = {}): Response {
  return json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }, status, extra);
}

/**
 * Compare two secrets without leaking their contents through timing. Length is
 * allowed to leak (the early return) — that's the standard trade-off, and it
 * keeps this dependency-free rather than reaching for a runtime-specific
 * `timingSafeEqual` that differs between workerd and Node.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(presented);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Pull the presented token off the request.
 *
 * `Authorization: Bearer <token>` is the way to do this and what every
 * config-file MCP client sends. The `?token=` fallback exists for one specific
 * reason: hosted connector UIs (claude.ai / Claude Desktop) assume a server
 * speaks OAuth and give you nowhere to attach a static header, so the URL is the
 * only channel left. It is a genuine downgrade — query strings land in
 * Cloudflare's request logs and in whatever config stores the URL — so the
 * header is checked first and the fallback is documented as the lesser path.
 */
function presentedToken(request: Request): string | undefined {
  const header = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim());
  if (header?.[1]) return header[1].trim();
  return new URL(request.url).searchParams.get('token')?.trim() || undefined;
}

/**
 * Gate the request. Returns a rejection Response, or `null` when the caller may
 * proceed. Fails CLOSED: no configured token means no service, because the
 * alternative is a public endpoint spending someone's AeroAPI quota.
 */
export function authorize(request: Request, env: WorkerEnv): Response | null {
  const expected = readEnvVar('MCP_AUTH_TOKEN', { env });
  if (!expected) {
    if (parseBoolEnv('MCP_ALLOW_ANONYMOUS', { env })) return null;
    return rpcError(
      503,
      'This deployment is not configured for use: no MCP_AUTH_TOKEN secret is set. Run `wrangler secret put MCP_AUTH_TOKEN` (or set MCP_ALLOW_ANONYMOUS=true to serve without auth — not recommended, AeroAPI bills per query).',
    );
  }
  const presented = presentedToken(request);
  if (!presented || !secretsMatch(presented, expected)) {
    return rpcError(401, 'Unauthorized: send `Authorization: Bearer <MCP_AUTH_TOKEN>`, or append ?token=<MCP_AUTH_TOKEN> to the URL if your client cannot set headers.', {
      'www-authenticate': 'Bearer realm="flightaware-mcp"',
    });
  }
  return null;
}

/**
 * Build a server + transport for one request, hand the request to it, and tear
 * both down.
 *
 * Closing immediately after `handleRequest` resolves is only safe because this
 * deployment is stateless + `enableJsonResponse`: in that mode the transport
 * resolves with a fully-materialised JSON body, so there's no stream still being
 * written into. The content-type check is belt-and-braces — if a response ever
 * does come back as SSE, it's left open rather than truncated.
 */
async function handleMcp(request: Request): Promise<Response> {
  const server = await createMcpServer({
    name: SERVER_NAME,
    version: VERSION,
    tools: TOOL_REGISTRARS,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  let response: Response;
  try {
    response = await transport.handleRequest(request);
  } finally {
    // Unconditional: only POST gets here, and in JSON-response mode its body is
    // fully materialised before handleRequest resolves, so there is no stream
    // left to truncate. Anything that could stream is rejected before this
    // point.
    await server.close().catch(() => {});
  }
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Bindings only exist per-request in Workers — publish them before any tool
    // (or the client singleton) reads config, and declare that nothing may write
    // files here (fa_get_flight_map returns its PNG inline instead).
    setEnvSource(env);
    setFilesystemAvailable(false);

    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Unauthenticated liveness + setup check: tells you whether each secret
    // actually landed, which is the thing you want to know right after a deploy.
    if (pathname === '/' || pathname === '/health') {
      return json({
        status: 'ok',
        name: SERVER_NAME,
        version: VERSION,
        transport: 'streamable-http',
        endpoint: MCP_PATH,
        tools: TOOL_COUNT,
        aeroapi_key: readEnvVar('AEROAPI_API_KEY', { env }) ? 'configured' : 'missing',
        auth: readEnvVar('MCP_AUTH_TOKEN', { env })
          ? 'bearer'
          : parseBoolEnv('MCP_ALLOW_ANONYMOUS', { env })
            ? 'anonymous'
            : 'unconfigured',
      });
    }

    if (pathname !== MCP_PATH) {
      return rpcError(404, `Not found. The MCP endpoint is ${MCP_PATH}.`);
    }

    const denied = authorize(request, env);
    if (denied) return denied;

    // Stateless: no standalone SSE stream to open, no session to delete. Say so
    // rather than letting the transport open a stream that can never deliver.
    if (request.method !== 'POST') {
      return rpcError(405, `Method ${request.method} not allowed: this deployment is stateless and serves MCP over POST ${MCP_PATH} only.`, {
        allow: 'POST, OPTIONS',
      });
    }

    return handleMcp(request);
  },
};
