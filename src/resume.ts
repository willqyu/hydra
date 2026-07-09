/**
 * Shared helper for seeding a worker from a prior Claude conversation.
 *
 * When a run is spawned with `--from-session <id>`, every worker resumes that
 * session so it inherits the full context (architecture, decisions, gotchas)
 * built up in the chat — then `--fork-session` gives each worker its own new
 * session id, so N workers forking the same base neither collide with each
 * other nor mutate the original conversation.
 */

/** CLI args that resume (and, by default, fork) a prior Claude session.
 *  Returns [] when no session is requested, so callers can spread it
 *  unconditionally into their arg list. */
export function resumeArgs(sessionId?: string, forkSession = true): string[] {
  if (!sessionId) return [];
  return forkSession ? ["--resume", sessionId, "--fork-session"] : ["--resume", sessionId];
}
