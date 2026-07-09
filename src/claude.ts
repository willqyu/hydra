import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface RunClaudeOptions {
  cwd: string;
  prompt: string;
  bin?: string;
  /** CLI args. Default ["-p", "--permission-mode", "acceptEdits"]. */
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Spawn through a shell (if bin is an alias/builtin). Default false. */
  shell?: boolean;
}

export interface RunClaudeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function defaultClaudeBin(): string {
  if (process.platform !== "win32") return "claude";
  // On Windows the CLI may install as claude.exe (native) OR claude.cmd/.bat (npm
  // shim). Resolve the one that actually exists on PATH, preferring .exe — it
  // spawns directly with no shell. Spawning a NON-EXISTENT claude.cmd throws
  // `spawn EINVAL` (Node's batch-file hardening fires on the .cmd name before it
  // checks existence), so we must not blindly assume claude.cmd is present.
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const ext of [".exe", ".cmd", ".bat"]) {
    for (const dir of dirs) {
      const full = path.join(dir, `claude${ext}`);
      if (existsSync(full)) return full;
    }
  }
  // Nothing found on PATH — fall back to the bare name and let spawn/shell sort it.
  return "claude.cmd";
}

/**
 * Decide whether to spawn `bin` through a shell. An explicit `shell` option always
 * wins. Otherwise: on Windows a `.cmd`/`.bat` shim (like `claude.cmd`) MUST run
 * through a shell — spawning a batch file directly throws `EINVAL` on modern Node
 * (the CVE-2024-27980 hardening). On POSIX the bin is a real executable, so we
 * spawn it directly. This is what lets the same hydra work on both WSL/Ubuntu
 * and native Windows.
 */
export function shouldUseShell(bin: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

/**
 * Run a headless Claude Code agent in a directory, feeding the prompt on stdin
 * (so task/conflict text needs no shell-escaping). Resolves with the exit code
 * and captured output; never rejects.
 */
export function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const bin = opts.bin ?? defaultClaudeBin();
  const args = opts.args ?? ["-p", "--permission-mode", "acceptEdits"];
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      shell: shouldUseShell(bin, opts.shell),
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\n[hydra] agent timed out";
    }, opts.timeoutMs ?? 30 * 60 * 1000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 0, stdout, stderr });
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
