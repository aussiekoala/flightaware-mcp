#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvSafely, runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { BANNER, SERVER_NAME, TOOL_REGISTRARS } from './registrars.js';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. the
// .mcpb bundle). loadDotenvSafely never lets .env override a host-provided
// value. This lives in the Node entrypoint (not client.ts) because the Worker
// build shares client.ts and forbids top-level I/O. Ordering is safe: the
// client reads config lazily, on the first tool call, long after this resolves.
const __dirname = dirname(fileURLToPath(import.meta.url));
await loadDotenvSafely({ path: join(__dirname, '..', '.env'), override: false });

// The FlightAwareClient is a module-level singleton (imported by each tool
// module) that defers its config error to the first request — so the server
// boots and answers the host's install-time tools/list probe even without
// AEROAPI_API_KEY.
await runMcp({
  name: SERVER_NAME,
  version: VERSION,
  banner: BANNER,
  tools: TOOL_REGISTRARS,
});
