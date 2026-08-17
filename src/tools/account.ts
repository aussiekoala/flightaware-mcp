import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { qs } from './shared.js';
import { currentMonthWindow, primeUsage, USAGE_PATH } from '../usage.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'fa_get_account_usage',
    {
      description:
        'Get AeroAPI account usage — what you have spent over a date window. Defaults to the current calendar month, which is the window the Personal tier\'s monthly free credit is measured against. AeroAPI bills per query at per-endpoint rates, so spend (not call count) is the number that matters.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        start: z.string().optional().describe('ISO-8601 start date (default: first of the current month, UTC)'),
        end: z.string().optional().describe('ISO-8601 end date (default: today, UTC)'),
      },
    },
    async ({ start, end }) => {
      const window = currentMonthWindow();
      const data = await client.get(`${USAGE_PATH}${qs({ start: start ?? window.start, end: end ?? window.end })}`);
      // Refresh the spend gate from this reading, but only when it covers the
      // default window — a caller inspecting some other date range must not
      // redefine "this month's spend". This is what makes the gate's error
      // hint ("check with fa_get_account_usage") actually clear a stale
      // failure instead of just describing one.
      if (start === undefined && end === undefined) primeUsage(data);
      return textResult(data);
    },
  );
}
