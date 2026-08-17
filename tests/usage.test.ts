import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import {
  formatUsage,
  parseUsage,
  currentMonthWindow,
  resetUsageCache,
  withUsageGuard,
  spendLimitUsd,
  usagePath,
  USAGE_PATH,
} from '../src/usage.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerOperatorTools } from '../src/tools/operators.js';
import { registerAlertTools } from '../src/tools/alerts.js';
import { client } from '../src/client.js';

const ENV_KEYS = [
  'AEROAPI_USAGE_FOOTER',
  'AEROAPI_FREE_CREDIT',
  'AEROAPI_SPEND_LIMIT',
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

/**
 * Jump the clock forward so the memo expires while `lastGood` (which only ages
 * out after the 15-minute grace window) survives.
 */
function advanceClock(ms: number) {
  const base = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(base + ms);
}

describe('parseUsage', () => {
  it('reads AeroAPI\'s real /account/usage payload', () => {
    // Captured from a live 200 on 2026-08-17 (Personal tier, empty month).
    expect(
      parseUsage({
        total_calls: 12,
        total_pages: 12,
        total_cost: 0.42,
        total_discount_cost: 0.1,
        total_successful_calls: 11,
        total_failed_calls: 1,
        resource_details: [],
      }),
    ).toEqual({ cost: 0.42, calls: 12 });
  });

  it('handles an all-zero month without reading it as "unknown"', () => {
    // $0 spent is a perfectly good answer and must not be mistaken for a
    // failure to parse — that distinction is what the gate turns on.
    expect(parseUsage({ total_calls: 0, total_cost: 0, resource_details: [] })).toEqual({ cost: 0, calls: 0 });
  });

  it('reads the aliased field names as a fallback', () => {
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
  it('sends whole-second datetimes, with end a minute in the PAST', () => {
    // Verified live: AeroAPI 400s on any end >= now, a bare date is read as
    // midnight (dropping all of today), and non-zero fractional seconds crash
    // its backend with a 500 Appfault. Datetimes, seconds precision, trailing
    // now.
    expect(currentMonthWindow(new Date('2026-08-17T09:00:00Z'))).toEqual({
      start: '2026-08-01T00:00:00Z',
      end: '2026-08-17T08:59:00Z',
    });
  });

  it('NEVER emits fractional seconds — non-zero milliseconds 500 AeroAPI', () => {
    // Date.toISOString() always carries milliseconds; a real clock essentially
    // never lands on .000, so an un-truncated window faults on every call.
    const { start, end } = currentMonthWindow(new Date('2026-08-17T09:00:00.417Z'));
    expect(start).not.toMatch(/\./);
    expect(end).not.toMatch(/\./);
    expect(end).toBe('2026-08-17T08:59:00Z');
  });

  it('NEVER sends an end in the future — the bug that took every tool offline', () => {
    for (const iso of ['2026-08-17T09:00:00Z', '2026-08-31T23:59:59Z', '2026-12-31T12:00:00Z', '2026-02-01T00:00:30Z']) {
      const now = new Date(iso);
      const { start, end } = currentMonthWindow(now);
      expect(new Date(end).getTime()).toBeLessThan(now.getTime());
      expect(new Date(end).getTime()).toBeGreaterThanOrEqual(new Date(start).getTime());
    }
  });

  it('clamps to the month start inside the first minute of a month', () => {
    expect(currentMonthWindow(new Date('2026-09-01T00:00:30Z'))).toEqual({
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-01T00:00:00Z',
    });
  });

  it('keeps the window inside the current month across a rollover', () => {
    expect(currentMonthWindow(new Date('2026-08-31T23:30:00Z'))).toEqual({
      start: '2026-08-01T00:00:00Z',
      end: '2026-08-31T23:29:00Z',
    });
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

  it('approves on an unparseable usage shape (nothing to compare against)', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    mockClient({ unexpected: 'shape' }, { operators: ['ok'] });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    expect((await h.callTool('fa_get_operator', { id: 'UAL' })).isError).toBeFalsy();
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

describe('spend gate — under approved, over declined, nothing else', () => {
  it('approves when the meter fails and no reading has ever succeeded', async () => {
    // Nothing to compare against → approve. Three incidents proved that
    // blocking on a silent meter takes the whole server down over pennies.
    process.env.AEROAPI_SPEND_LIMIT = '5';
    mockClient(() => {
      throw new Error('500 Appfault');
    }, { operators: ['ok'] });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    expect((await h.callTool('fa_get_operator', { id: 'UAL' })).isError).toBeFalsy();
    await h.close();
  });

  it('falls back to the last successful reading while the meter is down — under stays approved', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    let healthy = true;
    vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith(USAGE_PATH)) {
        if (!healthy) throw new Error('500 Appfault');
        return { total_cost: 4.99 };
      }
      return { operators: ['ok'] };
    });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    expect((await h.callTool('fa_get_operator', { id: 'UAL' })).isError).toBeFalsy();
    healthy = false;
    advanceClock(301_000); // memo expired, next read fails
    expect((await h.callTool('fa_get_operator', { id: 'DAL' })).isError).toBeFalsy();
    await h.close();
  });

  it('falls back to the last successful reading while the meter is down — over stays declined', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    let healthy = true;
    vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith(USAGE_PATH)) {
        if (!healthy) throw new Error('500 Appfault');
        return { total_cost: 6 };
      }
      return { operators: ['ok'] };
    });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    expect((await h.callTool('fa_get_operator', { id: 'UAL' })).isError).toBe(true);
    healthy = false;
    advanceClock(301_000);
    const res = await h.callTool('fa_get_operator', { id: 'DAL' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('spend limit reached');
    await h.close();
  });
});

describe('spend gate vs. confirm-gated writes', () => {
  it('a dry-run preview makes NO network call, even with the gate armed', async () => {
    // fa_delete_alert's own description promises this. The guard must not add a
    // billed usage lookup behind it, nor refuse the offline preview.
    process.env.AEROAPI_SPEND_LIMIT = '5';
    const get = mockClient({ total_cost: 999 });
    const write = vi.spyOn(client, 'write');
    const h = await createTestHarness(withUsageGuard(registerAlertTools) as never);
    const res = await h.callTool('fa_delete_alert', { id: 5 });
    expect(res.isError).toBeFalsy();
    expect(parseToolResult<{ dryRun: boolean }>(res).dryRun).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await h.close();
  });

  it('but a confirmed write is still gated', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    mockClient({ total_cost: 999 });
    const write = vi.spyOn(client, 'write').mockResolvedValue({ status: 204 });
    const h = await createTestHarness(withUsageGuard(registerAlertTools) as never);
    const res = await h.callTool('fa_delete_alert', { id: 5, confirm: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('spend limit reached');
    expect(write).not.toHaveBeenCalled();
    await h.close();
  });
});

describe('usage memo', () => {
  it('shares one query across concurrent tool calls', async () => {
    const get = mockClient({ total_cost: 1 });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    await Promise.all([
      h.callTool('fa_get_operator', { id: 'UAL' }),
      h.callTool('fa_get_operator', { id: 'DAL' }),
      h.callTool('fa_get_operator', { id: 'AAL' }),
    ]);
    expect(get.mock.calls.filter(([p]) => String(p).startsWith(USAGE_PATH))).toHaveLength(1);
    await h.close();
  });

  it('retries a failure sooner than it reuses a success', async () => {
    // Failures memoise for 15s, successes for the full 300s — so a blip is
    // re-checked quickly instead of leaving the gate blind for five minutes.
    process.env.AEROAPI_SPEND_LIMIT = '5';
    let attempts = 0;
    vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith(USAGE_PATH)) {
        attempts += 1;
        if (attempts === 1) throw new Error('transient 503');
        return { total_cost: 1 };
      }
      return { operators: [] };
    });
    const h = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    await h.callTool('fa_get_operator', { id: 'UAL' }); // read fails; call approved anyway
    expect(attempts).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000); // past 15s failure TTL
    await h.callTool('fa_get_operator', { id: 'DAL' }); // failure expired → re-read
    expect(attempts).toBe(2);
    await h.callTool('fa_get_operator', { id: 'AAL' }); // success memoised → no third read
    expect(attempts).toBe(2);
    await h.close();
  });


  it('fa_get_account_usage primes the gate — an over-limit reading it fetches starts blocking', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    let healthy = false;
    vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith(USAGE_PATH)) {
        if (!healthy) throw new Error('500 Appfault');
        return { total_cost: 6 }; // over the limit
      }
      return { operators: ['ok'] };
    });
    const gated = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    // Meter down, no reading ever → approved.
    expect((await gated.callTool('fa_get_operator', { id: 'UAL' })).isError).toBeFalsy();

    // The meter recovers; the account tool reads $6 and primes the gate.
    healthy = true;
    const account = await createTestHarness(withUsageGuard(registerAccountTools) as never);
    await account.callTool('fa_get_account_usage', {});

    expect((await gated.callTool('fa_get_operator', { id: 'DAL' })).isError).toBe(true);
    await gated.close();
    await account.close();
  });


  it('does not let a custom date window redefine this month\'s spend', async () => {
    process.env.AEROAPI_SPEND_LIMIT = '5';
    vi.spyOn(client, 'get').mockImplementation(async (path: string) => {
      // A 2020 window reporting $0 must not be mistaken for the current month,
      // which is over the limit.
      if (path.includes('start=2020-01-01')) return { total_cost: 0 };
      if (path.startsWith(USAGE_PATH)) return { total_cost: 6 };
      return { operators: [] };
    });
    const gated = await createTestHarness(withUsageGuard(registerOperatorTools) as never);
    expect((await gated.callTool('fa_get_operator', { id: 'UAL' })).isError).toBe(true);

    const account = await createTestHarness(withUsageGuard(registerAccountTools) as never);
    await account.callTool('fa_get_account_usage', { start: '2020-01-01', end: '2020-01-31' });

    // If that $0 had primed the memo, this would now sail through.
    expect((await gated.callTool('fa_get_operator', { id: 'DAL' })).isError).toBe(true);
    await gated.close();
    await account.close();
  });

});

describe('fa_get_account_usage', () => {
  it('queries the current calendar month by default', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ total_cost: 1 });
    const h = await createTestHarness(registerAccountTools);
    await h.callTool('fa_get_account_usage', {});
    expect(String(get.mock.calls[0][0])).toBe(usagePath());
    await h.close();
  });
});
