import http from "node:http";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { openSync, closeSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFleetStatus } from "./status.js";
import { readAgentLog, listAgentSessions, readSessionLog } from "./transcript.js";
import { readBranchLog } from "./branches.js";
import { InboxManager, type InboxKind } from "./inbox.js";
import { Registry } from "./registry.js";
import { CheckpointManager } from "./checkpoint.js";
import { loadConfig, saveConfig, sanitizeModel, CONFIG_ROLES, DEFAULT_PROMPTS } from "./config.js";
import { WorktreeManager } from "./worktree.js";
import { Git } from "./git.js";

/** Resolve the integration trunk: main, else master, else the current branch. */
async function resolveMain(git: Git): Promise<string> {
  if ((await git.tryRun(["rev-parse", "--verify", "--quiet", "main"])).code === 0) return "main";
  if ((await git.tryRun(["rev-parse", "--verify", "--quiet", "master"])).code === 0) return "master";
  return (await git.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
}

export interface ServerOptions {
  repoRoot: string;
  port?: number;
  host?: string;
  logger?: (m: string) => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// web/ sits next to src/ in the repo, and next to dist/ when built.
const WEB_DIR = path.resolve(here, "..", "web");
// Harness package root — cwd for re-spawned CLI commands so the tsx loader
// (passed via this process's execArgv) resolves from harness node_modules.
const HARNESS_ROOT = path.resolve(here, "..");

/** Spawn another harness CLI command the same way this process was launched
 *  (reusing node + its --import flags + the cli entrypoint). */
function spawnHarness(
  repoRoot: string,
  args: string[],
  logName: string,
  detached: boolean,
): ChildProcess {
  const harnessDir = path.join(repoRoot, ".harness");
  mkdirSync(harnessDir, { recursive: true });
  const fd = openSync(path.join(harnessDir, logName), "a");
  const cliPath = process.argv[1] ?? "";
  const options: SpawnOptions = {
    cwd: HARNESS_ROOT,
    detached,
    stdio: ["ignore", fd, fd],
    env: process.env,
  };
  const child = spawn(process.execPath, [...process.execArgv, cliPath, ...args], options);
  closeSync(fd);
  if (detached) child.unref();
  return child;
}

function sanitizeBranch(b: unknown): string {
  return String(b ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

// In-memory guard so the dashboard can't launch overlapping integration runs.
let integrating = false;

/**
 * Dependency-free dashboard: serves a single static page plus a JSON status API
 * the page polls. Read-only over the orchestrator's .harness state.
 */
export function startServer(opts: ServerOptions): http.Server {
  const port = opts.port ?? 4317;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.logger ?? console.log;

  const inbox = new InboxManager(opts.repoRoot);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "POST" && url.pathname === "/api/inject") {
        const body = await readBody(req);
        const { branch, text } = JSON.parse(body || "{}");
        if (!branch || !text) return send(res, 400, "application/json", '{"error":"branch and text required"}');
        await inbox.post(branch, { kind: "inject", text, from: "dashboard" });
        log(`inject → ${branch}: ${String(text).slice(0, 60)}`);
        return send(res, 200, "application/json", '{"ok":true}');
      }

      if (req.method === "POST" && url.pathname === "/api/control") {
        const body = await readBody(req);
        const { branch, action } = JSON.parse(body || "{}");
        const allowed: InboxKind[] = ["pause", "resume", "end"];
        if (!branch || !allowed.includes(action)) {
          return send(res, 400, "application/json", '{"error":"branch and action (pause|resume|end) required"}');
        }
        await inbox.post(branch, { kind: action, from: "dashboard" });
        log(`control → ${branch}: ${action}`);
        return send(res, 200, "application/json", '{"ok":true}');
      }

      if (req.method === "POST" && url.pathname === "/api/integrate") {
        if (integrating) {
          return send(res, 409, "application/json", '{"error":"integration already running"}');
        }
        const body = await readBody(req);
        const { test, maxRounds } = JSON.parse(body || "{}");
        const args = ["integrate", "--repo", opts.repoRoot, "--dangerous", "--prioritized"];
        if (test && String(test).trim()) args.push("--test", String(test).trim());
        if (maxRounds) args.push("--max-rounds", String(parseInt(String(maxRounds), 10) || 3));
        integrating = true;
        const child = spawnHarness(opts.repoRoot, args, "integrate.log", false);
        child.on("exit", () => { integrating = false; });
        child.on("error", () => { integrating = false; });
        log(`integrate started${test ? ` (test: ${String(test).slice(0, 40)})` : " (textual-only)"}`);
        return send(res, 200, "application/json", '{"ok":true,"started":true}');
      }

      if (req.method === "POST" && url.pathname === "/api/spawn") {
        const body = await readBody(req);
        const { description, branch, mode, continueFrom, model } = JSON.parse(body || "{}");
        if (!description || !String(description).trim()) {
          return send(res, 400, "application/json", '{"error":"description required"}');
        }
        // Hand off to `harness plan`: the supervisor decides single-vs-fleet and,
        // when continuing, seeds the prior branch's context + forks from its head.
        const request = {
          description: String(description),
          branch: sanitizeBranch(branch) || undefined,
          mode: ["single", "auto", "split"].includes(mode) ? mode : "auto",
          continueFrom: continueFrom ? sanitizeBranch(continueFrom) : undefined,
          // Per-run worker model override (a model picked in the Spawn panel).
          model: sanitizeModel(model) || undefined,
        };
        const reqFile = path.join(os.tmpdir(), `harness-plan-${Date.now().toString(36)}.json`);
        await writeFile(reqFile, JSON.stringify(request, null, 2));
        spawnHarness(opts.repoRoot, ["plan", reqFile, "--repo", opts.repoRoot, "--dangerous"], "spawn.log", true);
        log(`plan spawned (mode=${request.mode}${request.continueFrom ? `, continue ${request.continueFrom}` : ""}${request.model ? `, model ${request.model}` : ""})`);
        return send(res, 200, "application/json", JSON.stringify({ ok: true, planning: true }));
      }

      if (req.method === "POST" && url.pathname === "/api/extend") {
        const body = await readBody(req);
        const { branch, text } = JSON.parse(body || "{}");
        const b = sanitizeBranch(branch);
        if (!b || !text || !String(text).trim()) {
          return send(res, 400, "application/json", '{"error":"branch and text required"}');
        }
        const reg = await Registry.open(path.join(opts.repoRoot, ".harness", "registry.json"));
        const entry = reg.all().find((e) => e.branch === b);
        // Too late to extend once the branch has landed in main.
        const git = new Git(opts.repoRoot);
        const mainBranch = await resolveMain(git);
        if (entry?.head && (await git.tryRun(["merge-base", "--is-ancestor", entry.head, mainBranch])).code === 0) {
          return send(res, 409, "application/json", '{"error":"branch already integrated into main — spawn a new task instead"}');
        }
        if (entry?.state === "running") {
          // Live worker: steer it in place.
          await inbox.post(b, { kind: "inject", text: String(text), from: "dashboard" });
          log(`extend → ${b}: injected to running worker`);
          return send(res, 200, "application/json", JSON.stringify({ ok: true, mode: "injected" }));
        }
        // If this branch is checked out in the main working tree, free it first —
        // a continuation worker can't `git worktree add` a branch already checked
        // out elsewhere (this was the silent extend failure).
        const cur = (await git.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        if (cur === b) {
          if ((await git.tryRun(["status", "--porcelain"])).stdout.trim()) {
            return send(res, 409, "application/json", '{"error":"this branch is checked out with uncommitted changes — commit or stash them first"}');
          }
          await git.tryRun(["checkout", mainBranch]);
          log(`extend → ${b}: freed it from the working tree (checked out ${mainBranch})`);
        }
        // Terminal but un-integrated: continue it with a seeded follow-up worker.
        const request = { description: String(text), continueFrom: b, mode: "single" };
        const reqFile = path.join(os.tmpdir(), `harness-plan-${Date.now().toString(36)}.json`);
        await writeFile(reqFile, JSON.stringify(request, null, 2));
        spawnHarness(opts.repoRoot, ["plan", reqFile, "--repo", opts.repoRoot, "--dangerous"], "spawn.log", true);
        log(`extend → ${b}: spawned continuation`);
        return send(res, 200, "application/json", JSON.stringify({ ok: true, mode: "continued" }));
      }

      if (req.method === "POST" && url.pathname === "/api/checkout") {
        const body = await readBody(req);
        const { branch } = JSON.parse(body || "{}");
        const b = sanitizeBranch(branch);
        if (!b) return send(res, 400, "application/json", '{"error":"branch required"}');
        const git = new Git(opts.repoRoot);
        // Refuse to switch with unsaved work — git would clobber or block anyway.
        if ((await git.tryRun(["status", "--porcelain"])).stdout.trim()) {
          return send(res, 409, "application/json", '{"error":"working tree has uncommitted changes — stash or commit them first"}');
        }
        const r = await git.tryRun(["checkout", b]);
        if (r.code !== 0) {
          return send(res, 409, "application/json", JSON.stringify({ error: r.stderr.trim() || `could not checkout ${b}` }));
        }
        log(`checkout → working tree now on ${b}`);
        return send(res, 200, "application/json", JSON.stringify({ ok: true, branch: b }));
      }

      if (req.method === "POST" && url.pathname === "/api/delete-branch") {
        const body = await readBody(req);
        const { branch } = JSON.parse(body || "{}");
        const b = sanitizeBranch(branch);
        if (!b) return send(res, 400, "application/json", '{"error":"branch required"}');
        const git = new Git(opts.repoRoot);
        const mainBranch = await resolveMain(git);
        if (b === mainBranch) {
          return send(res, 400, "application/json", '{"error":"refusing to delete the trunk branch"}');
        }
        const reg = await Registry.open(path.join(opts.repoRoot, ".harness", "registry.json"));
        const entry = reg.all().find((e) => e.branch === b);
        if (entry?.state === "running") {
          return send(res, 409, "application/json", '{"error":"a worker is still running on this branch — let it finish first"}');
        }
        const cur = (await git.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        if (cur === b) {
          return send(res, 409, "application/json", '{"error":"branch is checked out in the working tree — switch to main first"}');
        }
        // Remove its worktree (if any), delete the branch, then clean up state.
        await new WorktreeManager(opts.repoRoot, path.join(opts.repoRoot, ".harness", "worktrees"))
          .remove(b, { force: true }).catch(() => {});
        const del = await git.tryRun(["branch", "-D", b]);
        if (del.code !== 0) {
          return send(res, 409, "application/json", JSON.stringify({ error: del.stderr.trim() || `could not delete ${b}` }));
        }
        await reg.remove(b);
        await new CheckpointManager(path.join(opts.repoRoot, ".harness", "checkpoints")).remove(b);
        log(`deleted branch ${b}`);
        return send(res, 200, "application/json", JSON.stringify({ ok: true, branch: b }));
      }

      if (req.method === "POST" && url.pathname === "/api/stash") {
        const git = new Git(opts.repoRoot);
        const r = await git.tryRun(["stash", "push", "-u", "-m", "harness dashboard"]);
        if (r.code !== 0) {
          return send(res, 409, "application/json", JSON.stringify({ error: r.stderr.trim() || "stash failed" }));
        }
        log(`stash → ${r.stdout.trim() || "saved working tree"}`);
        return send(res, 200, "application/json", JSON.stringify({ ok: true, detail: r.stdout.trim() }));
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readBody(req);
        let raw: unknown;
        try { raw = JSON.parse(body || "{}"); } catch {
          return send(res, 400, "application/json", '{"error":"invalid JSON"}');
        }
        const cfg = await saveConfig(opts.repoRoot, raw);
        log("config updated (prompts/models)");
        return send(res, 200, "application/json", JSON.stringify({ ok: true, config: cfg }));
      }

      if (url.pathname === "/api/config") {
        const cfg = await loadConfig(opts.repoRoot);
        // `defaults` lets the Settings page pre-fill each prompt box with the
        // standing system prompt the role actually ships with.
        return send(res, 200, "application/json", JSON.stringify({ config: cfg, roles: CONFIG_ROLES, defaults: DEFAULT_PROMPTS }));
      }

      if (url.pathname === "/api/tasks") {
        // Searchable task catalogue for the "continue from" picker: every branch
        // the harness knows (registry + checkpoints), matched against BOTH the
        // branch name and the task's initial prompt (the checkpoint description).
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const reg = await Registry.open(path.join(opts.repoRoot, ".harness", "registry.json"));
        const cps = await new CheckpointManager(path.join(opts.repoRoot, ".harness", "checkpoints")).list();
        const cpByBranch = new Map(cps.map((c) => [c.branch, c]));
        const seen = new Set<string>();
        const tasks: Array<{ branch: string; taskId: string; state: string; description: string; updatedAt: string }> = [];
        for (const e of reg.all()) {
          const cp = cpByBranch.get(e.branch);
          tasks.push({ branch: e.branch, taskId: e.taskId, state: e.state, description: cp?.description ?? "", updatedAt: e.updatedAt });
          seen.add(e.branch);
        }
        for (const c of cps) {
          // Orphan checkpoints (no registry entry) are still continuable work.
          if (!seen.has(c.branch)) tasks.push({ branch: c.branch, taskId: c.taskId, state: "completed", description: c.description, updatedAt: c.createdAt });
        }
        const terms = q.split(/\s+/).filter(Boolean);
        const matched = terms.length
          ? tasks.filter((t) => {
              const hay = `${t.branch} ${t.taskId} ${t.description}`.toLowerCase();
              return terms.every((w) => hay.includes(w));
            })
          : tasks;
        const out = matched
          .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
          .slice(0, 50)
          .map((t) => ({ ...t, description: t.description.slice(0, 240) }));
        return send(res, 200, "application/json", JSON.stringify({ tasks: out }));
      }

      if (url.pathname === "/api/status") {
        const status = await readFleetStatus(opts.repoRoot);
        return send(res, 200, "application/json", JSON.stringify({ ...status, integrating }));
      }
      if (url.pathname === "/api/log") {
        const branch = url.searchParams.get("branch") ?? "";
        const offset = Number(url.searchParams.get("offset") ?? "0") || 0;
        if (!branch) return send(res, 400, "application/json", '{"error":"branch required"}');
        const chunk = await readAgentLog(opts.repoRoot, branch, offset);
        return send(res, 200, "application/json", JSON.stringify(chunk));
      }
      if (url.pathname === "/api/agents") {
        const agents = await listAgentSessions(opts.repoRoot);
        return send(res, 200, "application/json", JSON.stringify({ agents }));
      }
      if (url.pathname === "/api/gitgraph") {
        // Structured commit graph across every local branch (each worktree's
        // branch + main), newest first — the dashboard draws it as vector lines.
        const git = new Git(opts.repoRoot);
        const SEP = "\x1f";
        const r = await git.tryRun([
          "log", `--pretty=%H${SEP}%P${SEP}%D${SEP}%s`, "--branches", "--date-order", "-n", "300",
        ]);
        const commits = r.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [hash, parents, refs, subject] = l.split(SEP);
            return {
              hash: hash ?? "",
              parents: parents ? parents.split(" ").filter(Boolean) : [],
              refs: refs ?? "",
              subject: subject ?? "",
            };
          });
        return send(res, 200, "application/json", JSON.stringify({ commits }));
      }
      if (url.pathname === "/api/agentlog") {
        const id = url.searchParams.get("id") ?? "";
        const offset = Number(url.searchParams.get("offset") ?? "0") || 0;
        if (!id) return send(res, 400, "application/json", '{"error":"id required"}');
        const chunk = await readSessionLog(opts.repoRoot, id, offset);
        return send(res, 200, "application/json", JSON.stringify(chunk));
      }
      if (url.pathname === "/api/branches") {
        const branches = await readBranchLog(opts.repoRoot);
        return send(res, 200, "application/json", JSON.stringify({ branches }));
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(path.join(WEB_DIR, "index.html"), "utf8");
        return send(res, 200, "text/html; charset=utf-8", html);
      }
      if (url.pathname === "/branches" || url.pathname === "/branches.html") {
        const html = await readFile(path.join(WEB_DIR, "branches.html"), "utf8");
        return send(res, 200, "text/html; charset=utf-8", html);
      }
      if (url.pathname === "/hydra" || url.pathname === "/hydra.html") {
        const html = await readFile(path.join(WEB_DIR, "hydra.html"), "utf8");
        return send(res, 200, "text/html; charset=utf-8", html);
      }
      if (url.pathname === "/settings" || url.pathname === "/settings.html") {
        const html = await readFile(path.join(WEB_DIR, "settings.html"), "utf8");
        return send(res, 200, "text/html; charset=utf-8", html);
      }
      send(res, 404, "text/plain", "not found");
    } catch (err) {
      send(res, 500, "text/plain", String(err));
    }
  });

  server.listen(port, host, () => {
    log(`harness dashboard → http://${host}:${port}  (repo: ${opts.repoRoot})`);
  });
  return server;
}

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
