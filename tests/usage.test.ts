import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import {
  formatUsage,
  parseUsage,
  currentMonthWindow,
  resetUsageCache,
  withUsageGuard,
  spendLimitUsd,
  USAGE_PATH,
} from '../src/usage.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerOperatorTools } from '../src/tools/operators.js';
import { client } from '../src/client.js';

const ENV_KEYS = [
  'AEROAPI_USAGE_FOOTER',
  'AEROAPI_FREE_CREDIT',
  'AEROAPI_SPEND_LIMIT',
  'AEROAPI_ALLOW_UNVERIFIED_SPEND',
];

afterEach(() => {
  resetUsageCache();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

/** Mock client.get: usage reads resolve to `usage`, everything else to a stub. */
function mockClient(usage: unknown | (() => never), tool: unknown = { operators: [] }) {
  return vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
    if (path.startsWith(USAGE_PATH)) {
      if (typeof usage === 'function') return (usage as () => never)();
      return usage;
    }
    return tool;
  });
}

describe('parseUsage', () => {
  it('reads the documented and aliased field names', () => {
    expect(parseUsage({ total_cost: 1.5, total_calls: 9 })).toEqual({ cost: 1.5, calls: 9 });
    expect(parseUsage({ cost: '2.25' })).toEqual({ cost: 2.25, calls: undefined });
  });

  it('returns null on an unrecognised shape rather than inventing a number', () => {
    // /account/usage is [verify-pending]; a fabricated figure would be worse
    // than none, and the gate reads null as "cannot verify", not "you're fine".
    expect(parseUsage({ something_else: true })).toBeNull();
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage('nope')).toBeNull();
  });
});

describe('formatUsage', () => {
  it('reports spend against the monthly credit', () => {
    expect(formatUsage({ cost: 1.234, calls: 42 }, 5)).toBe(
      '— AeroAPI usage: $1.23 spent this month · $3.77 of $5.00 credit remaining · 42 queries',
    );
  });

  it('flags going over the credit as billable rather than showing a negative balance', () => {
    expect(formatUsage({ cost: 7.5 }, 5)).toContain('$2.50 OVER the $5.00 credit — billable');
  });

  it('says nothing when there is nothing to say', () => {
    expect(formatUsage(null, 5)).toBeNull();
  });
});

describe('currentMonthWindow', () => {
  it('spans first-of-month to today in UTC', () => {
    expect(currentMonthWindow(new Date('2026-08-17T09:00:00Z'))).toEqual({ start: '2026-08-01', end: '2026-08-17' });
  });
});

describe('spendLimitUsd', () => {
  it('is undefined (gate off) unless set to a usable number', () => {
    expect(spendLimitUsd()).toBeUndefined();
    process.env.AEROAPI_SPEND_LIMIT = 'not-a-number';
    expect(spendLimitUsd()).toBeUndefined();
    process.env.AEROAPI_SPEND_LIMIT = '5';
    expect(spendLimitUsd()).toBe(5);
  });
});

describe('usage footer', () => {
  it('appends the usage line to every tool result', async () => {
    mockClient({ total_cost: 0.5, total_calls: 10 });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    const texts = res.content.map((c: { text?: string }) => c.text ?? '');
    expect(texts.some((t) => t.includes('$4.50 of $5.00 credit remaining'))).toBe(true);
    await h.close();
  });

  it('spends only one usage query across a burst of tool calls', async () => {
    const get = mockClient({ total_cost: 1 });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    await h.callTool('fa_get_operator', { id: 'UAL' });
    await h.callTool('fa_get_operator', { id: 'DAL' });
    await h.callTool('fa_get_operator', { id: 'AAL' });
    expect(get.mock.calls.filter(([p]) => String(p).startsWith(USAGE_PATH))).toHaveLength(1);
    await h.close();
  });

  it('never breaks a working tool call when the usage lookup fails', async () => {
    mockClient(() => {
      throw new Error('402 tier does not expose usage');
    }, { operators: ['ok'] });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.isError).toBeFalsy();
    expect(parseToolResult(res)).toEqual({ operators: ['ok'] });
    await h.close();
  });

  it('can be switched off with AEROAPI_USAGE_FOOTER=false', async () => {
    process.env.AEROAPI_USAGE_FOOTER = 'false';
    const get = mockClient({ total_cost: 1 });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.content).toHaveLength(1);
    expect(get.mock.calls.some(([p]) => String(p).startsWith(USAGE_PATH))).toBe(false);
    await h.close();
  });

  it('honours a custom credit via AEROAPI_FREE_CREDIT', async () => {
    process.env.AEROAPI_FREE_CREDIT = '20';
    mockClient({ total_cost: 5 });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    const texts = res.content.map((c: { text?: string }) => c.text ?? '').join(' ');
    expect(texts).toContain('$15.00 of $20.00 credit remaining');
    await h.close();
  });
});

describe('spend gate', () => {
  it('is off by default — no limit set means no blocking', async () => {
    mockClient({ total_cost: 999 });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.isError).toBeFalsy();
    await h.close();
  });

  it('allows a call while spend is under the limit', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    mockClient({ total_cost: 4.99 });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.isError).toBeFalsy();
    await h.close();
  });

  it('blocks at the limit WITHOUT making the upstream call', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    const get = mockClient({ total_cost: 5 });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('spend limit reached');
    // The whole point: the blocked tool spent nothing. Only the usage read ran.
    expect(get.mock.calls.every(([p]) => String(p).startsWith(USAGE_PATH))).toBe(true);
    await h.close();
  });

  it('fails CLOSED when spend cannot be verified and a limit is set', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    const get = mockClient(() => {
      throw new Error('404 not found');
    });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('cannot be verified');
    expect(get.mock.calls.every(([p]) => String(p).startsWith(USAGE_PATH))).toBe(true);
    await h.close();
  });

  it('treats an unparseable usage shape as unverified, not as zero spend', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    mockClient({ unexpected: 'shape' });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('cannot be verified');
    await h.close();
  });

  it('AEROAPI_ALLOW_UNVERIFIED_SPEND=true opts out of failing closed', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    process.env.AEROAPI_ALLOW_UNVERIFIED_SPEND = 'true';
    mockClient(() => {
      throw new Error('404 not found');
    }, { operators: ['ok'] });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.isError).toBeFalsy();
    await h.close();
  });

  it('never gates fa_get_account_usage — you can always ask why you are blocked', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    mockClient({ total_cost: 500 });
    const h = await createTestHarness(withUsageGuard(registerAccountTools) as never);
    const res = await h.callTool('fa_get_account_usage', {});
    expect(res.isError).toBeFalsy();
    expect(parseToolResult(res)).toEqual({ total_cost: 500 });
    await h.close();
  });
});

describe('fa_get_account_usage', () => {
  it('queries the current calendar month by default', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ total_cost: 1 });
    const h = await createTestHarness(registerAccountTools);
    await h.callTool('fa_get_account_usage', {});
    const path = String(get.mock.calls[0][0]);
    expect(path).toContain(USAGE_PATH);
    expect(path).toContain(`start=${currentMonthWindow().start}`);
    await h.close();
  });
});
