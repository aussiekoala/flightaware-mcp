/**
 * Per-response usage reporting.
 *
 * AeroAPI bills per query at per-endpoint rates, and the Personal tier includes
 * a monthly credit rather than a call allowance — so the number worth watching
 * is spend against that credit, and it's worth seeing *without having to ask*.
 * This module appends a one-line usage summary to every tool result, so the
 * remaining balance rides along with whatever you were actually doing.
 *
 * Two things keep that from being self-defeating:
 *  - the reading is memoised for AEROAPI_USAGE_TTL seconds (default 300), so a
 *    burst of tool calls costs at most one extra query per window; and
 *  - any failure is swallowed. A usage lookup must never turn a working tool
 *    call into an error, and an unrecognised response shape prints nothing
 *    rather than a guess.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readEnvVar, readTtlMsEnv, parseBoolEnv, type ToolRegistrar } from '@chrischall/mcp-utils';
import { envSource } from './runtime.js';
import { client } from './client.js';

export const USAGE_PATH = '/account/usage';

/** How long a usage reading is reused before another query is spent on it. */
const DEFAULT_USAGE_TTL_MS = 300_000;
/** Monthly credit the Personal tier includes, in USD. Override per plan. */
const DEFAULT_FREE_CREDIT_USD = 5;

/** Tools whose own output already is the usage figure — no footer needed. */
const SKIP_FOOTER = new Set(['fa_get_account_usage']);

let cached: { text: string | null; at: number } | null = null;

/** Reset the memoised reading (test hook). */
export function resetUsageCache(): void {
  cached = null;
}

/** First-of-month → today, in UTC, as ISO dates. The window the credit resets on. */
export function currentMonthWindow(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
}

/** Pull the first present numeric field from a set of plausible aliases. */
function num(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // AeroAPI has been seen returning money as a string in places.
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

/**
 * Render the footer from a usage payload, or `null` if the shape isn't
 * recognised. The response shape is [verify-pending] (see
 * docs/FLIGHTAWARE-API.md), which is exactly why this returns null instead of
 * inventing a number.
 */
export function formatUsage(data: unknown, creditUsd: number): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const cost = num(record, 'total_cost', 'cost', 'total_usd', 'amount');
  const calls = num(record, 'total_calls', 'calls', 'total_queries', 'queries');
  if (cost === undefined && calls === undefined) return null;

  const parts: string[] = [];
  if (cost !== undefined) {
    parts.push(`$${cost.toFixed(2)} spent this month`);
    if (creditUsd > 0) {
      const left = creditUsd - cost;
      parts.push(
        left >= 0
          ? `$${left.toFixed(2)} of $${creditUsd.toFixed(2)} credit remaining`
          : `$${Math.abs(left).toFixed(2)} OVER the $${creditUsd.toFixed(2)} credit — billable`,
      );
    }
  }
  if (calls !== undefined) parts.push(`${calls} queries`);
  return `— AeroAPI usage: ${parts.join(' · ')}`;
}

/** The memoised footer line, or null when disabled/unavailable/unparseable. */
async function usageLine(): Promise<string | null> {
  const env = envSource();
  if (!parseBoolEnv('AEROAPI_USAGE_FOOTER', { env, default: true })) return null;

  const ttlMs = readTtlMsEnv('AEROAPI_USAGE_TTL', DEFAULT_USAGE_TTL_MS, { env });
  const now = Date.now();
  if (cached && ttlMs > 0 && now - cached.at < ttlMs) return cached.text;

  const creditRaw = readEnvVar('AEROAPI_FREE_CREDIT', { env });
  const credit = creditRaw !== undefined && Number.isFinite(Number(creditRaw)) ? Number(creditRaw) : DEFAULT_FREE_CREDIT_USD;

  let text: string | null = null;
  try {
    const window = currentMonthWindow();
    const data = await client.get(`${USAGE_PATH}?start=${window.start}&end=${window.end}`);
    text = formatUsage(data, credit);
  } catch {
    // Never let a usage lookup break a working tool call. A missing key, a tier
    // that doesn't expose /account/usage, a network blip — all just mean no
    // footer this time.
    text = null;
  }
  cached = { text, at: now };
  return text;
}

/** Append the usage line to a tool result, leaving the result alone on failure. */
async function appendUsage(result: CallToolResult): Promise<CallToolResult> {
  if (!Array.isArray(result.content)) return result;
  const line = await usageLine();
  if (!line) return result;
  return { ...result, content: [...result.content, { type: 'text' as const, text: line }] };
}

type ToolHandler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/**
 * Wrap a registrar so every tool it registers reports usage alongside its own
 * output.
 *
 * The Proxy forwards property reads to the real server bound to the real server
 * — not to the proxy — because McpServer holds private class fields, and a
 * method invoked with the proxy as `this` would throw on the first `#field`
 * access.
 */
export function withUsageFooter(register: ToolRegistrar): ToolRegistrar {
  return (server, deps) => {
    const proxied = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop !== 'registerTool') {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (name: string, config: unknown, handler: ToolHandler) => {
          const wrapped: ToolHandler = SKIP_FOOTER.has(name)
            ? handler
            : async (...args: unknown[]) => appendUsage(await handler(...args));
          return (target.registerTool as unknown as (...a: unknown[]) => unknown)(name, config, wrapped);
        };
        void receiver;
      },
    }) as McpServer;
    return register(proxied, deps);
  };
}
