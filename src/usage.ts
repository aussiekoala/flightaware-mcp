/**
 * Usage reporting and the spend gate.
 *
 * AeroAPI bills per query at per-endpoint rates, and the Personal tier includes
 * a monthly credit rather than a call allowance — so the number worth watching
 * is dollars against that credit. This module does two things with one reading:
 *
 *  1. **Reports** it, appending a one-line summary to every tool result so the
 *     balance rides along with whatever you were already doing.
 *  2. **Enforces** it, when AEROAPI_SPEND_LIMIT is set: the reading is taken
 *     BEFORE the tool's own call, and a tool over the limit makes no upstream
 *     request at all.
 *
 * One reading serves both, memoised for AEROAPI_USAGE_TTL seconds (default
 * 300), so a burst of tool calls costs at most one extra query per window. Note
 * what that implies for the gate: spend is re-checked once per TTL window, not
 * once per call, so the ceiling is enforced to within one window's worth of
 * activity. Shorten the TTL to tighten it.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readEnvVar, readTtlMsEnv, parseBoolEnv, McpToolError, type ToolRegistrar } from '@chrischall/mcp-utils';
import { envSource } from './runtime.js';
import { client } from './client.js';

export const USAGE_PATH = '/account/usage';

/** How long a usage reading is reused before another query is spent on it. */
const DEFAULT_USAGE_TTL_MS = 300_000;
/** Monthly credit the Personal tier includes, in USD. Override per plan. */
const DEFAULT_FREE_CREDIT_USD = 5;

/**
 * Tools exempt from the spend gate. `fa_get_account_usage` must always work —
 * being unable to ask "why am I blocked?" while blocked would be a trap.
 */
const UNGATED = new Set(['fa_get_account_usage']);

/** What we managed to read out of an /account/usage response. */
export interface UsageReading {
  cost?: number;
  calls?: number;
}

let memo: { reading: UsageReading | null; failure: string | null; at: number } | null = null;

/** Reset the memoised reading (test hook). */
export function resetUsageCache(): void {
  memo = null;
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
 * Read cost/calls out of an /account/usage payload, or `null` if the shape
 * isn't recognised.
 *
 * **[verify-pending]** — the real response shape has not been confirmed against
 * a live 200 (see docs/FLIGHTAWARE-API.md). Returning null on an unknown shape
 * is deliberate: reporting prints nothing rather than a fabricated number, and
 * the gate treats it as "cannot verify" rather than "you're fine".
 */
export function parseUsage(data: unknown): UsageReading | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const cost = num(record, 'total_cost', 'cost', 'total_usd', 'amount');
  const calls = num(record, 'total_calls', 'calls', 'total_queries', 'queries');
  if (cost === undefined && calls === undefined) return null;
  return { cost, calls };
}

/** Render the footer line from a reading, or null when there's nothing to say. */
export function formatUsage(reading: UsageReading | null, creditUsd: number): string | null {
  if (!reading) return null;
  const parts: string[] = [];
  if (reading.cost !== undefined) {
    parts.push(`$${reading.cost.toFixed(2)} spent this month`);
    if (creditUsd > 0) {
      const left = creditUsd - reading.cost;
      parts.push(
        left >= 0
          ? `$${left.toFixed(2)} of $${creditUsd.toFixed(2)} credit remaining`
          : `$${Math.abs(left).toFixed(2)} OVER the $${creditUsd.toFixed(2)} credit — billable`,
      );
    }
  }
  if (reading.calls !== undefined) parts.push(`${reading.calls} queries`);
  if (parts.length === 0) return null;
  return `— AeroAPI usage: ${parts.join(' · ')}`;
}

function creditUsd(): number {
  const raw = readEnvVar('AEROAPI_FREE_CREDIT', { env: envSource() });
  return raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_FREE_CREDIT_USD;
}

/** The configured hard ceiling in USD, or undefined when the gate is off. */
export function spendLimitUsd(): number | undefined {
  const raw = readEnvVar('AEROAPI_SPEND_LIMIT', { env: envSource() });
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Fetch (or reuse) the current month's usage. Never throws. */
async function readUsage(): Promise<{ reading: UsageReading | null; failure: string | null }> {
  const ttlMs = readTtlMsEnv('AEROAPI_USAGE_TTL', DEFAULT_USAGE_TTL_MS, { env: envSource() });
  const now = Date.now();
  if (memo && ttlMs > 0 && now - memo.at < ttlMs) return memo;

  let reading: UsageReading | null = null;
  let failure: string | null = null;
  try {
    const window = currentMonthWindow();
    const data = await client.get(`${USAGE_PATH}?start=${window.start}&end=${window.end}`);
    reading = parseUsage(data);
    if (!reading) failure = `${USAGE_PATH} returned a shape this server does not recognise`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  memo = { reading, failure, at: now };
  return memo;
}

/**
 * The spend gate. Throws (blocking the tool call before it reaches AeroAPI)
 * when the month's spend is at or over AEROAPI_SPEND_LIMIT.
 *
 * Fails CLOSED: if a limit is set and spend cannot be verified, the call is
 * blocked rather than allowed through on an assumption. That is the point of a
 * hard limit — an unverifiable budget is not a satisfied budget.
 * AEROAPI_ALLOW_UNVERIFIED_SPEND=true opts out for tiers that don't expose
 * /account/usage.
 */
export async function enforceSpendLimit(): Promise<void> {
  const limit = spendLimitUsd();
  if (limit === undefined) return; // gate off — reporting only

  const { reading, failure } = await readUsage();

  if (!reading || reading.cost === undefined) {
    if (parseBoolEnv('AEROAPI_ALLOW_UNVERIFIED_SPEND', { env: envSource() })) return;
    throw new McpToolError(
      `AeroAPI spend cannot be verified, and AEROAPI_SPEND_LIMIT is set to $${limit.toFixed(2)}, so this call was blocked before reaching AeroAPI. Reason: ${failure ?? 'no cost field in the usage response'}.`,
      {
        hint: 'Check the key and tier with fa_get_account_usage (which is never gated). To proceed without verification set AEROAPI_ALLOW_UNVERIFIED_SPEND=true, or unset AEROAPI_SPEND_LIMIT to disable the gate.',
      },
    );
  }

  if (reading.cost >= limit) {
    throw new McpToolError(
      `AeroAPI spend limit reached: $${reading.cost.toFixed(2)} spent this month, limit is $${limit.toFixed(2)}. No AeroAPI call was made.`,
      {
        hint: 'Raise AEROAPI_SPEND_LIMIT (or unset it to disable the gate) — otherwise the limit clears when the monthly window rolls over. On Cloudflare: `wrangler secret put AEROAPI_SPEND_LIMIT` or edit [vars] in wrangler.toml.',
      },
    );
  }
}

/** Append the usage line to a tool result, leaving the result alone on failure. */
async function appendUsage(result: CallToolResult): Promise<CallToolResult> {
  if (!Array.isArray(result.content)) return result;
  if (!parseBoolEnv('AEROAPI_USAGE_FOOTER', { env: envSource(), default: true })) return result;
  const { reading } = await readUsage();
  const line = formatUsage(reading, creditUsd());
  if (!line) return result;
  return { ...result, content: [...result.content, { type: 'text' as const, text: line }] };
}

type ToolHandler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/**
 * Wrap a registrar so every tool it registers checks the spend limit before
 * doing its work, and reports usage after.
 *
 * The Proxy forwards property reads to the real server bound to the real server
 * — not to the proxy — because McpServer holds private class fields, and a
 * method invoked with the proxy as `this` would throw on the first `#field`
 * access.
 */
export function withUsageGuard(register: ToolRegistrar): ToolRegistrar {
  return (server, deps) => {
    const proxied = new Proxy(server, {
      get(target, prop) {
        if (prop !== 'registerTool') {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (name: string, config: unknown, handler: ToolHandler) => {
          const wrapped: ToolHandler = UNGATED.has(name)
            ? handler
            : async (...args: unknown[]) => {
                // Gate first: an over-budget call must cost nothing.
                await enforceSpendLimit();
                return appendUsage(await handler(...args));
              };
          return (target.registerTool as unknown as (...a: unknown[]) => unknown)(name, config, wrapped);
        };
      },
    }) as McpServer;
    return register(proxied, deps);
  };
}
