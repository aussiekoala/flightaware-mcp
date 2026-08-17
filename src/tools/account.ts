import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { qs } from './shared.js';
import { currentMonthWindow, USAGE_PATH } from '../usage.js';

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
      return textResult(data);
    },
  );
}
