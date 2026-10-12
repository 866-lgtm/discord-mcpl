import { appendFileSync } from 'node:fs';

// Diagnostic file logger - bypasses the host's stderr capture (which has been
// observed to silently drop lines on some host builds). Set
// DISCORD_MCPL_DEBUG_LOG to a writable absolute path to enable.
//
// Read per-call, NOT snapshotted at module load: test-file load order is not
// guaranteed (bun evaluates other test files' import graphs — which include
// this module — before a test that sets the env var gets to run its body), and
// an env read here costs nothing next to the appendFileSync below.
export function dbg(tag: string, info: Record<string, unknown> = {}): void {
  const DEBUG_LOG_PATH = process.env.DISCORD_MCPL_DEBUG_LOG;
  if (!DEBUG_LOG_PATH) return;
  try {
    appendFileSync(
      DEBUG_LOG_PATH,
      `${new Date().toISOString()} ${tag} ${JSON.stringify(info)}\n`,
    );
  } catch {
    // Logging is best-effort; never break Discord delivery because of it.
  }
}
