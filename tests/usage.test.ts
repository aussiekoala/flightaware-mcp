import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { formatUsage, currentMonthWindow, resetUsageCache, withUsageFooter, USAGE_PATH } from '../src/usage.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerOperatorTools } from '../src/tools/operators.js';
import { client } from '../src/client.js';

afterEach(() => {
  resetUsageCache();
  vi.restoreAllMocks();
  delete process.env.AEROAPI_USAGE_FOOTER;
  delete process.env.AEROAPI_FREE_CREDIT;
});

describe('formatUsage', () => {
  it('reports spend against the monthly credit', () => {
    expect(formatUsage({ total_cost: 1.234, total_calls: 42 }, 5)).toBe(
      '— AeroAPI usage: $1.23 spent this month · $3.77 of $5.00 credit remaining · 42 queries',
    );
  });

  it('flags going over the credit as billable rather than showing a negative balance', () => {
    expect(formatUsage({ total_cost: 7.5 }, 5)).toContain('$2.50 OVER the $5.00 credit — billable');
  });

  it('accepts money returned as a string', () => {
    expect(formatUsage({ total_cost: '2.00' }, 5)).toContain('$2.00 spent');
  });

  it('returns null on an unrecognised shape rather than inventing a number', () => {
    // The /account/usage response shape is [verify-pending]; printing a guess
    // would be worse than printing nothing.
    expect(formatUsage({ something_else: true }, 5)).toBeNull();
    expect(formatUsage(null, 5)).toBeNull();
    expect(formatUsage('nope', 5)).toBeNull();
  });
});

describe('currentMonthWindow', () => {
  it('spans first-of-month to today in UTC', () => {
    expect(currentMonthWindow(new Date('2026-08-17T09:00:00Z'))).toEqual({ start: '2026-08-01', end: '2026-08-17' });
  });
});

describe('usage footer', () => {
  it('appends the usage line to every tool result', async () => {
    vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith(USAGE_PATH)) return { total_cost: 0.5, total_calls: 10 };
      return { operators: [] };
    });
    const h = await createTestHarness(withUsageFooter(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    const texts = res.content.map((c: { text?: string }) => c.text ?? '');
    expect(texts.some((t) => t.includes('$4.50 of $5.00 credit remaining'))).toBe(true);
    await h.close();
  });

  it('spends only one usage query across a burst of tool calls', async () => {
    const get = vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith(USAGE_PATH)) return { total_cost: 1 };
      return { operators: [] };
    });
    const h = await createTestHarness(withUsageFooter(registerOperatorTools) as never);
    await h.callTool('fa_get_operator', { id: 'UAL' });
    await h.callTool('fa_get_operator', { id: 'DAL' });
    await h.callTool('fa_get_operator', { id: 'AAL' });
    const usageCalls = get.mock.calls.filter(([p]) => String(p).startsWith(USAGE_PATH));
    expect(usageCalls).toHaveLength(1);
    await h.close();
  });

  it('never breaks a working tool call when the usage lookup fails', async () => {
    vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith(USAGE_PATH)) throw new Error('402 tier does not expose usage');
      return { operators: ['ok'] };
    });
    const h = await createTestHarness(withUsageFooter(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(res.isError).toBeFalsy();
    expect(parseToolResult(res)).toEqual({ operators: ['ok'] });
    await h.close();
  });

  it('can be switched off with AEROAPI_USAGE_FOOTER=false', async () => {
    process.env.AEROAPI_USAGE_FOOTER = 'false';
    const get = vi.spyOn(client, 'get').mockResolvedValue({ operators: [] });
    const h = await createTestHarness(withUsageFooter(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    expect(get.mock.calls.some(([p]) => String(p).startsWith(USAGE_PATH))).toBe(false);
    expect(res.content).toHaveLength(1);
    await h.close();
  });

  it('honours a custom credit via AEROAPI_FREE_CREDIT', async () => {
    process.env.AEROAPI_FREE_CREDIT = '20';
    vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith(USAGE_PATH)) return { total_cost: 5 };
      return { operators: [] };
    });
    const h = await createTestHarness(withUsageFooter(registerOperatorTools) as never);
    const res = await h.callTool('fa_get_operator', { id: 'UAL' });
    const texts = res.content.map((c: { text?: string }) => c.text ?? '').join(' ');
    expect(texts).toContain('$15.00 of $20.00 credit remaining');
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

  it('does not append a footer to itself', async () => {
    vi.spyOn(client, 'get').mockResolvedValue({ total_cost: 1 });
    const h = await createTestHarness(withUsageFooter(registerAccountTools) as never);
    const res = await h.callTool('fa_get_account_usage', {});
    expect(res.content).toHaveLength(1);
    await h.close();
  });
});
