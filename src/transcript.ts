import { readFile, readdir, stat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Live agent transcript reader for the dashboard.
 *
 * Each worker is a Claude Code session running in its branch worktree, and
 * Claude Code streams a full transcript (thinking, assistant text, tool calls)
 * to `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. We tail that file so the
 * dashboard can show an agent's reasoning live — no worker-side changes needed.
 */

export interface LogEvent {
  kind: "thinking" | "text" | "tool" | "result" | "user";
  text: string;
  /** ISO timestamp of the transcript line this event came from, if present. */
  ts?: string;
}

export interface LogChunk {
  /** Byte offset to pass back next poll for incremental reads. */
  offset: number;
  events: LogEvent[];
  /** True while the worktree's transcript exists (agent has/had a session). */
  found: boolean;
}

/** Claude Code encodes a session's cwd into its project-dir name by replacing
 *  path separators and `.`/`_` with `-` (e.g. /a/.b/c_d -> -a--b-c-d). */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/._]/g, "-");
}

/** Where the orchestrator places a branch's worktree (mirror of WorktreeManager). */
function worktreePath(repoRoot: string, branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(repoRoot, ".harness", "worktrees", safe);
}

async function newestTranscript(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }
  let best: { f: string; m: number } | null = null;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const s = await stat(path.join(projectDir, f));
      if (!best || s.mtimeMs > best.m) best = { f, m: s.mtimeMs };
    } catch {
      /* skip */
    }
  }
  return best ? path.join(projectDir, best.f) : null;
}

function clip(s: unknown, n = 2000): string {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + " …" : str;
}

function toolArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v =
    i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.description ?? i.prompt;
  return v ? clip(v, 200) : "";
}

/** Extract human-readable events from one transcript line. */
function eventsFromLine(o: any): LogEvent[] {
  const out: LogEvent[] = [];
  const type = o?.type;
  const content = o?.message?.content;
  const ts = typeof o?.timestamp === "string" ? o.timestamp : undefined;

  if (type === "assistant" && Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "thinking") {
        // Extended thinking is often redacted at rest (empty text + signature);
        // show the content when present, else a marker so the reasoning cadence
        // is still visible in the stream.
        const t = String(b.thinking ?? "").trim();
        out.push({ kind: "thinking", text: t ? clip(t) : "(thinking…)" });
      } else if (b.type === "text" && b.text) out.push({ kind: "text", text: clip(b.text) });
      else if (b.type === "tool_use") {
        const arg = toolArg(b.input);
        out.push({ kind: "tool", text: clip(`${b.name || "tool"}${arg ? " · " + arg : ""}`, 240) });
      }
    }
  } else if (type === "user") {
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && b.text) out.push({ kind: "user", text: clip(b.text, 600) });
      }
    } else if (typeof content === "string") {
      out.push({ kind: "user", text: clip(content, 600) });
    }
  }
  if (ts) for (const e of out) e.ts = ts;
  return out;
}

/**
 * Newest activity timestamp for a branch's agent — the mtime of its live
 * transcript file. Lets the dashboard flag a running agent that has gone quiet
 * without parsing the whole transcript on every poll. Null if no session yet.
 */
export async function latestActivityAt(repoRoot: string, branch: string): Promise<string | null> {
  const wt = worktreePath(repoRoot, branch);
  const projectDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(wt));
  const file = await newestTranscript(projectDir);
  if (!file) return null;
  try {
    const s = await stat(file);
    return new Date(s.mtimeMs).toISOString();
  } catch {
    return null;
  }
}

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

/** Read transcript events from a specific .jsonl file starting at `offset`
 *  (a byte offset). Only whole lines are consumed; returns the next read point. */
async function readFromFile(file: string, offset: number): Promise<LogChunk> {
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    return { offset, events: [], found: true };
  }
  if (offset > buf.length) offset = 0; // file rotated / new session

  const slice = buf.subarray(offset).toString("utf8");
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl < 0) return { offset, events: [], found: true };

  const consumable = slice.slice(0, lastNl + 1);
  const newOffset = offset + Buffer.byteLength(consumable, "utf8");

  const events: LogEvent[] = [];
  for (const line of consumable.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    for (const e of eventsFromLine(o)) events.push(e);
  }
  return { offset: newOffset, events, found: true };
}

/**
 * Read new transcript events for a branch's agent from `offset` (a byte offset).
 * Reads the newest session in the branch's worktree (the live worker).
 */
export async function readAgentLog(repoRoot: string, branch: string, offset = 0): Promise<LogChunk> {
  const wt = worktreePath(repoRoot, branch);
  const projectDir = path.join(PROJECTS_ROOT, encodeProjectDir(wt));
  const file = await newestTranscript(projectDir);
  if (!file) return { offset, events: [], found: false };
  return readFromFile(file, offset);
}

/** One Claude Code session running (or run) for this repo's harness. */
export interface AgentSession {
  /** Opaque, URL-safe key: `<projectDir>::<sessionId>`. */
  id: string;
  /** worker = branch worktree; negotiator = integration worktree; supervisor =
   *  the planning/naming agent that runs in the repo root before the fleet. */
  role: "worker" | "negotiator" | "supervisor";
  /** Git branch the session ran on (from the transcript), e.g. feat/x or integration/staging. */
  branch?: string;
  /** Transcript filename (uuid), without the .jsonl extension. */
  sessionId: string;
  /** First user prompt, clipped — the agent's brief (task, or conflict to resolve). */
  title: string;
  /** Timestamp of the first transcript line. */
  startedAt?: string;
  /** Transcript file mtime — proxy for last activity. */
  lastActivityAt: string;
}

/** The encoded ~/.claude/projects dir prefix shared by every worktree of this repo. */
function worktreesPrefix(repoRoot: string): string {
  return encodeProjectDir(path.join(repoRoot, ".harness", "worktrees"));
}

/** Read the first ~64KB of a transcript to extract its branch, opening prompt and start time. */
async function readSessionMeta(file: string): Promise<{ branch?: string; title: string; startedAt?: string }> {
  let head = "";
  try {
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return { title: "" };
  }
  let branch: string | undefined;
  let title = "";
  let startedAt: string | undefined;
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (!startedAt && typeof o.timestamp === "string") startedAt = o.timestamp;
    if (!branch && typeof o.gitBranch === "string" && o.gitBranch) branch = o.gitBranch;
    if (!title) {
      for (const e of eventsFromLine(o)) {
        if (e.kind === "user" && e.text.trim()) {
          title = e.text.trim();
          break;
        }
      }
    }
    if (branch && title) break;
  }
  return { branch, title: title.slice(0, 160), startedAt };
}

/** The supervisor and branch-naming agents both run in the repo root; identify
 *  their sessions (vs the user's own interactive ones) by their opening prompt. */
function isPlannerTitle(title: string): boolean {
  return (
    /^You are the SUPERVISOR for a parallel multi-agent/.test(title) ||
    /^Summarize the following task as a git branch name/.test(title)
  );
}

/** Collect sessions from one project dir. When `plannerOnly`, keep only the most
 *  recent files and only those whose opening prompt is a harness planner. */
async function collectSessions(
  dir: string,
  role: AgentSession["role"],
  plannerOnly: boolean,
): Promise<AgentSession[]> {
  const projectDir = path.join(PROJECTS_ROOT, dir);
  let files: string[];
  try {
    files = (await readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  let entries = await Promise.all(
    files.map(async (f) => {
      try {
        return { f, m: (await stat(path.join(projectDir, f))).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  let ranked = entries.filter((e): e is { f: string; m: number } => e !== null);
  if (plannerOnly) {
    // Bound cost in a busy repo-root dir: only inspect the most recent sessions.
    ranked = ranked.sort((a, b) => b.m - a.m).slice(0, 40);
  }
  const out: AgentSession[] = [];
  for (const { f, m } of ranked) {
    const meta = await readSessionMeta(path.join(projectDir, f));
    if (plannerOnly && !isPlannerTitle(meta.title)) continue;
    const sessionId = f.slice(0, -".jsonl".length);
    out.push({
      id: `${dir}::${sessionId}`,
      role,
      branch: meta.branch,
      sessionId,
      title: meta.title,
      startedAt: meta.startedAt,
      lastActivityAt: new Date(m).toISOString(),
    });
  }
  return out;
}

/**
 * Enumerate every Claude session for this repo's harness — workers (branch
 * worktrees), negotiators (the integration worktree), AND the supervisor /
 * branch-naming agents that plan in the repo root before the fleet. Scans
 * ~/.claude/projects so sessions stay visible even after a worktree is cleaned up.
 */
export async function listAgentSessions(repoRoot: string): Promise<AgentSession[]> {
  const prefix = worktreesPrefix(repoRoot);
  const repoDir = encodeProjectDir(repoRoot); // repo-root project dir (planner sessions)
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_ROOT);
  } catch {
    return [];
  }
  const out: AgentSession[] = [];
  for (const dir of dirs) {
    if (dir === repoDir) {
      out.push(...(await collectSessions(dir, "supervisor", true)));
    } else if (dir === prefix || dir.startsWith(prefix + "-")) {
      const remainder = dir.slice(prefix.length); // encoded worktree name
      const role: AgentSession["role"] = /integration|staging/i.test(remainder) ? "negotiator" : "worker";
      out.push(...(await collectSessions(dir, role, false)));
    }
  }
  // Most-recently-active first.
  out.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
  return out;
}

/**
 * Read one specific agent session's transcript by its `AgentSession.id`. The
 * project dir is validated against this repo's worktree prefix so the endpoint
 * can't be used to read arbitrary transcripts elsewhere on disk.
 */
export async function readSessionLog(repoRoot: string, id: string, offset = 0): Promise<LogChunk> {
  const sep = id.indexOf("::");
  if (sep < 0) return { offset, events: [], found: false };
  const dir = id.slice(0, sep);
  const sessionId = id.slice(sep + 2);
  const prefix = worktreesPrefix(repoRoot);
  // Allow this repo's worktree dirs and its repo-root dir (supervisor sessions).
  const inRepo = dir === prefix || dir.startsWith(prefix + "-") || dir === encodeProjectDir(repoRoot);
  if (!inRepo || dir.includes("/") || dir.includes("..") || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return { offset, events: [], found: false };
  }
  const file = path.join(PROJECTS_ROOT, dir, `${sessionId}.jsonl`);
  try {
    await stat(file);
  } catch {
    return { offset, events: [], found: false };
  }
  return readFromFile(file, offset);
}
