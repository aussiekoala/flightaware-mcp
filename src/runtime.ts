/**
 * Runtime shims — the two things that differ between the Node (stdio) build and
 * the Cloudflare Workers build, kept behind one tiny module so no tool or client
 * has to branch on "am I in a Worker?".
 *
 * 1. **Where config comes from.** Under Node it's `process.env`, populated by the
 *    MCP host and `.env`. A Worker has no `process.env` at module-evaluation
 *    time — bindings and secrets arrive as the `env` argument to `fetch()` — so
 *    `src/worker.ts` installs that object here on every request, before any tool
 *    runs. Everything that reads config goes through {@link envSource}.
 * 2. **Whether a filesystem exists.** Only `fa_get_flight_map` cares: on Node it
 *    writes the PNG to disk and returns a path; a Worker has nowhere durable to
 *    write, so the tool returns the image inline instead.
 */

/** A `process.env`-shaped bag of config values. */
export type EnvSource = Record<string, string | undefined>;

let installedEnv: EnvSource | null = null;
let filesystemAvailable = true;

/**
 * Install the config source (the Worker's `env` bindings object). Called once
 * per request by the Worker entrypoint; the Node entrypoint never calls it and
 * falls through to `process.env`.
 */
export function setEnvSource(source: EnvSource): void {
  installedEnv = source;
}

/** The active config source: whatever was installed, else `process.env`, else `{}`. */
export function envSource(): EnvSource {
  if (installedEnv) return installedEnv;
  return (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};
}

/** Drop an installed source and fall back to `process.env` (test hook). */
export function resetEnvSource(): void {
  installedEnv = null;
}

/**
 * Declare whether this runtime has a usable filesystem. Defaults to `true`
 * (Node); `src/worker.ts` sets it `false`.
 */
export function setFilesystemAvailable(available: boolean): void {
  filesystemAvailable = available;
}

/** Whether tools may write files to disk. */
export function hasFilesystem(): boolean {
  return filesystemAvailable;
}
