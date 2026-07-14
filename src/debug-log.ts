import { appendFileSync } from 'node:fs';

// Diagnostic file logger - bypasses the host's stderr capture (which has been
// observed to silently drop lines on some host builds). Set
// DISCORD_MCPL_DEBUG_LOG to a writable absolute path to enable.
const DEBUG_LOG_PATH = process.env.DISCORD_MCPL_DEBUG_LOG;

export function dbg(tag: string, info: Record<string, unknown> = {}): void {
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
