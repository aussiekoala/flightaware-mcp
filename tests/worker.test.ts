import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { authorize, type WorkerEnv } from '../src/worker.js';
import { resetEnvSource, setFilesystemAvailable } from '../src/runtime.js';

// The Worker installs its request-scoped bindings into the shared runtime
// module, so undo that between cases or one test's env leaks into the next.
afterEach(() => {
  resetEnvSource();
  setFilesystemAvailable(true);
  vi.restoreAllMocks();
});

const TOKEN = 'test-bearer-token';
const ENV: WorkerEnv = { AEROAPI_API_KEY: 'test-aero-key', MCP_AUTH_TOKEN: TOKEN };

function post(body: unknown, opts: { token?: string; path?: string } = {}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(`https://example.workers.dev${opts.path ?? '/mcp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** POST a JSON-RPC message and parse the JSON body the transport replies with. */
async function rpc(body: unknown, env: WorkerEnv = ENV, token: string | undefined = TOKEN) {
  const res = await worker.fetch(post(body, { token }), env);
  return { res, json: (await res.json()) as Record<string, any> };
}

describe('worker auth gate', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await worker.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects a wrong bearer token', async () => {
    const res = await worker.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'wrong' }), ENV);
    expect(res.status).toBe(401);
  });

  it('rejects a token that is a prefix of the real one (no truncated-compare bug)', async () => {
    const res = await worker.fetch(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: TOKEN.slice(0, -1) }),
      ENV,
    );
    expect(res.status).toBe(401);
  });

  it('fails CLOSED with 503 when no MCP_AUTH_TOKEN is configured', async () => {
    // AeroAPI bills per query — an unconfigured deployment must not be an open
    // endpoint that anyone can spend the key on.
    const res = await worker.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
      AEROAPI_API_KEY: 'k',
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('MCP_AUTH_TOKEN');
  });

  it('serves without a token only when MCP_ALLOW_ANONYMOUS is explicitly set', async () => {
    const denied = authorize(post({}), { AEROAPI_API_KEY: 'k', MCP_ALLOW_ANONYMOUS: 'true' });
    expect(denied).toBeNull();
  });

  it('accepts the correct bearer token', async () => {
    expect(authorize(post({}, { token: TOKEN }), ENV)).toBeNull();
  });

  it('accepts the token as a ?token= query param (for clients that cannot set headers)', async () => {
    const req = new Request(`https://example.workers.dev/mcp?token=${TOKEN}`, { method: 'POST' });
    expect(authorize(req, ENV)).toBeNull();
  });

  it('rejects a wrong ?token= query param', async () => {
    const req = new Request('https://example.workers.dev/mcp?token=wrong', { method: 'POST' });
    expect(authorize(req, ENV)?.status).toBe(401);
  });

  it('prefers the Authorization header over ?token= when both are present', async () => {
    const req = new Request('https://example.workers.dev/mcp?token=wrong', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorize(req, ENV)).toBeNull();
  });

  it('still serves MCP when authenticated by query param alone', async () => {
    const res = await worker.fetch(
      new Request(`https://example.workers.dev/mcp?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.serverInfo.name).toBe('flightaware-mcp');
  });
});

describe('worker MCP endpoint', () => {
  it('answers initialize', async () => {
    const { res, json } = await rpc({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    expect(res.status).toBe(200);
    expect(json.result.serverInfo.name).toBe('flightaware-mcp');
  });

  it('serves the full tool roster over HTTP', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (json.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toHaveLength(33);
    expect(names).toContain('fa_get_flights');
    expect(names).toContain('fa_create_alert');
  });

  it('reads the AeroAPI key from the Worker binding, not process.env', async () => {
    // The whole point of the runtime env-source indirection: a Worker's secrets
    // arrive per-request, and process.env is empty.
    const prior = process.env.AEROAPI_API_KEY;
    delete process.env.AEROAPI_API_KEY;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"flights":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const { json } = await rpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'fa_get_flights', arguments: { ident: 'BINDINGTEST1' } },
      });
      expect(json.result.isError).toBeFalsy();
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = new Headers(init.headers as HeadersInit);
      expect(headers.get('x-apikey')).toBe('test-aero-key');
    } finally {
      if (prior !== undefined) process.env.AEROAPI_API_KEY = prior;
    }
  });

  it('surfaces the actionable config error when the key binding is missing', async () => {
    const prior = process.env.AEROAPI_API_KEY;
    delete process.env.AEROAPI_API_KEY;
    try {
      const { json } = await rpc(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'fa_get_flights', arguments: { ident: 'NOKEYTEST1' } },
        },
        { MCP_AUTH_TOKEN: TOKEN },
      );
      expect(json.result.isError).toBe(true);
      expect(JSON.stringify(json.result.content)).toContain('AEROAPI_API_KEY');
    } finally {
      if (prior !== undefined) process.env.AEROAPI_API_KEY = prior;
    }
  });

  it('returns the flight map inline (no filesystem on Workers)', async () => {
    const png = Buffer.from('fake-png').toString('base64');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ map: png }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'fa_get_flight_map', arguments: { id: 'MAPTEST-1-airline-0001' } },
    });
    // No `output_dir`, no `inline` — on Node this writes a file and returns a
    // path; on the Worker it must come back as an image instead.
    expect(json.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: png });
  });
});

describe('worker routing', () => {
  it('/health reports version, endpoint, and which secrets landed', async () => {
    const res = await worker.fetch(new Request('https://example.workers.dev/health'), ENV);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', endpoint: '/mcp', aeroapi_key: 'configured', auth: 'bearer' });
  });

  it('/health flags an unconfigured deployment', async () => {
    const res = await worker.fetch(new Request('https://example.workers.dev/health'), {});
    expect(await res.json()).toMatchObject({ aeroapi_key: 'missing', auth: 'unconfigured' });
  });

  it('404s any path that is not the MCP endpoint', async () => {
    const res = await worker.fetch(new Request('https://example.workers.dev/nope'), ENV);
    expect(res.status).toBe(404);
  });

  it('answers the CORS preflight', async () => {
    const res = await worker.fetch(new Request('https://example.workers.dev/mcp', { method: 'OPTIONS' }), ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });
});
