import type { ToolRegistrar } from '@chrischall/mcp-utils';
import { registerFlightTools } from './tools/flights.js';
import { registerAirportTools } from './tools/airports.js';
import { registerOperatorTools } from './tools/operators.js';
import { registerAircraftTools } from './tools/aircraft.js';
import { registerScheduleTools } from './tools/schedules.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerAccountTools } from './tools/account.js';
import { withUsageFooter } from './usage.js';

/** Server name advertised to the host, shared by both transports. */
export const SERVER_NAME = 'flightaware-mcp';

export const BANNER =
  '[flightaware-mcp] This project was developed and is maintained by AI (Claude). Use at your own discretion.';

/**
 * The tool roster, in registration order. Shared by both entrypoints — the Node
 * stdio server (src/index.ts) and the Cloudflare Worker (src/worker.ts) — so a
 * new tool module is wired into both by editing one list.
 *
 * Every registrar is wrapped so its tools append the AeroAPI spend-vs-credit
 * line to their results (see src/usage.ts). Wrapping here rather than in each
 * tool module means a new module gets the reporting for free.
 */
export const TOOL_REGISTRARS: ToolRegistrar[] = [
  registerFlightTools,
  registerAirportTools,
  registerOperatorTools,
  registerAircraftTools,
  registerScheduleTools,
  registerAlertTools,
  registerAccountTools,
].map(withUsageFooter);

/**
 * How many tools the roster registers. Surfaced by the Worker's /health so a
 * deploy can be sanity-checked without authenticating; `tests/index.test.ts`
 * asserts it against the actually-registered set, so it cannot silently drift.
 */
export const TOOL_COUNT = 34;
