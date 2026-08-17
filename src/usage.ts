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

/**
 * A failed reading is held for far less time than a good one. With the gate
 * armed a failure blocks every tool, so caching a blip for the full 300s would
 * turn one bad response into five minutes of downtime.
 */
const FAILURE_TTL_MS = 15_000;

/** Seconds to step `end` back from now, absorbing clock skew against AeroAPI. */
const END_SKEW_MS = 60_000;

/**
 * How long a last-known-good reading keeps the gate open after the meter
 * breaks, and how much headroom that reading needs. See {@link enforceSpendLimit}.
 */
const GRACE_MS = 900_000;
const GRACE_HEADROOM = 0.9;

type Memo = { reading: UsageReading | null; failure: string | null; at: number };

let memo: Memo | null = null;
/** The most recent reading that actually succeeded — the grace window's basis. */
let lastGood: { reading: UsageReading; at: number } | null = null;
/** The read currently in flight, so parallel tool calls share one query. */
let inFlight: Promise<Memo> | null = null;

/** Reset the memoised reading (test hook). */
export function resetUsageCache(): void {
  memo = null;
  lastGood = null;
  inFlight = null;
}

/**
 * Seed the memo from a reading someone else already paid for — used by
 * `fa_get_account_usage` so that calling it (the remedy the gate's error
 * message points at) actually refreshes the gate rather than leaving a stale
 * failure in place.
 */
export function primeUsage(data: unknown): void {
  const reading = parseUsage(data);
  if (!reading) return;
  memo = { reading, failure: null, at: Date.now() };
  lastGood = { reading, at: memo.at };
}

/**
 * The current billing window in UTC: first of the month → a moment ago.
 *
 * Both bounds are full ISO-8601 **datetimes**, not bare dates. Verified against
 * the live API on 2026-08-17:
 *
 *  - `end` in the future → `400 "start or end datetime must be before current
 *    datetime"`. AeroAPI rejects it outright; there is no tolerance for
 *    "tomorrow". An earlier revision sent tomorrow, and because the spend gate
 *    fails closed, that single bad parameter took every tool offline.
 *  - `end` as a bare date (`2026-08-17`) → parsed as that day's midnight, so
 *    all of today is excluded. Returned 0 calls on a day that had activity.
 *  - `end` as a past datetime (`2026-08-17T20:00:00Z`) → today's usage counted.
 *
 * Hence a datetime, one minute back, truncated to whole seconds (see
 * {@link isoSeconds} — fractional seconds crash AeroAPI's backend with a 500).
 * The skew matters because `end` must be strictly before AeroAPI's idea of
 * now, and our clock is not theirs.
 *
 * Edge case: inside the first minute of a UTC month, `now - skew` precedes the
 * month start, so the window clamps to zero width. Month-to-date spend is zero
 * at that point anyway.
 */
export function currentMonthWindow(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Math.max(start.getTime(), now.getTime() - END_SKEW_MS));
  return { start: isoSeconds(start), end: isoSeconds(end) };
}

/**
 * ISO-8601 truncated to whole seconds — `2026-08-17T21:33:00Z`, never
 * `...:00.417Z`. AeroAPI's backend faults with `500 Appfault` on non-zero
 * fractional seconds (verified live 2026-08-17: `.000Z` → 200, `.417Z` → 500,
 * same query otherwise), and `Date.toISOString()` always emits milliseconds.
 * Deterministic, not a transient outage — so we simply never send them.
 */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The default-window usage path. Shared with `fa_get_account_usage` so both
 * spell the query identically — same encoding, same cache key.
 */
export function usagePath(window = currentMonthWindow()): string {
  const params = new URLSearchParams({ start: window.start, end: window.end });
  return `${USAGE_PATH}?${params.toString()}`;
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
 * Confirmed against a real 200 (2026-08-17): AeroAPI returns `total_calls`,
 * `total_pages`, `total_cost`, `total_discount_cost`, `total_successful_calls`,
 * `total_failed_calls` and a `resource_details[]` breakdown.
 *
 * We gate on **`total_cost`, the gross figure**, deliberately ignoring
 * `total_discount_cost`. Its exact semantics are unclear from an all-zero
 * response — it may be the amount already covered by credit — and for a budget
 * the safe direction is to over-count, blocking slightly early rather than
 * letting spend through on an optimistic reading.
 *
 * The aliases below are kept as a fallback: returning null on an unknown shape
 * means reporting prints nothing rather than a fabricated number, and the gate
 * reads it as "cannot verify" rather than "you're fine".
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
async function readUsage(): Promise<Memo> {
  const ttlMs = readTtlMsEnv('AEROAPI_USAGE_TTL', DEFAULT_USAGE_TTL_MS, { env: envSource() });
  const now = Date.now();
  if (memo && ttlMs > 0) {
    // Successes are held for the full TTL; failures for a much shorter one, so
    // a transient error can't hard-block the gate for the whole window.
    const age = now - memo.at;
    const limit = memo.failure === null ? ttlMs : Math.min(ttlMs, FAILURE_TTL_MS);
    if (age < limit) return memo;
  }
  // Share one query across concurrent callers: without this, N parallel tool
  // calls each bill their own usage read.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let reading: UsageReading | null = null;
    let failure: string | null = null;
    try {
      const data = await client.get(usagePath());
      reading = parseUsage(data);
      if (!reading) failure = `${USAGE_PATH} returned a shape this server does not recognise`;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    memo = { reading, failure, at: Date.now() };
    if (reading) lastGood = { reading, at: memo.at };
    return memo;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
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

    // Grace window. A broken meter should not take the whole server down —
    // that amplification is exactly what a bad `end` parameter caused once
    // already. If we have a recent reading that actually succeeded and it sat
    // comfortably under the limit, spend cannot have crossed it in the
    // meantime, so keep serving rather than blocking on a transient fault.
    // This still refuses when the meter has NEVER worked, when the last good
    // reading sat close enough to the limit to matter, or when it is stale
    // enough that real spend could have accumulated behind it.
    if (
      lastGood &&
      lastGood.reading.cost !== undefined &&
      lastGood.reading.cost < limit * GRACE_HEADROOM &&
      Date.now() - lastGood.at < GRACE_MS
    ) {
      return;
    }

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
 * Does this tool's schema carry a `confirm` flag? Confirm-gated writes promise,
 * in their own description, that without `confirm: true` they make NO network
 * call — so the guard must not add one behind their back.
 */
function isConfirmGated(config: unknown): boolean {
  const schema = (config as { inputSchema?: Record<string, unknown> } | undefined)?.inputSchema;
  return !!schema && Object.prototype.hasOwnProperty.call(schema, 'confirm');
}

/** A dry-run call on a confirm-gated tool: no confirm:true, so nothing bills. */
function isDryRun(args: unknown[]): boolean {
  const first = args[0] as { confirm?: unknown } | undefined;
  return !first || first.confirm !== true;
}

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
          const confirmGated = isConfirmGated(config);
          const wrapped: ToolHandler = UNGATED.has(name)
            ? handler
            : async (...args: unknown[]) => {
                // A dry-run preview on a confirm-gated write must stay entirely
                // offline — its description promises "makes NO network call",
                // and a usage lookup (billed, and refusable when the gate is
                // armed) would break that promise in both directions.
                if (confirmGated && isDryRun(args)) return handler(...args);
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
