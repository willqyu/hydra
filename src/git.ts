import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

/** Thin async wrapper around the `git` CLI, scoped to a working directory. */
export class Git {
  constructor(public readonly cwd: string) {}

  /** Run a git command; throws on non-zero exit. Returns trimmed stdout. */
  async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await pexec("git", args, { cwd: this.cwd, maxBuffer: MAX_BUFFER });
      return stdout.trim();
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(`git ${args.join(" ")} failed: ${e.stderr || e.message || String(err)}`);
    }
  }

  /**
   * Run a git command without throwing on non-zero exit. Useful where a
   * non-zero code is expected and meaningful (e.g. `merge-tree` reporting
   * conflicts in M2).
   */
  async tryRun(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await pexec("git", args, { cwd: this.cwd, maxBuffer: MAX_BUFFER });
      return { code: 0, stdout, stderr };
    } catch (err: unknown) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  }

  async head(): Promise<string> {
    return this.run(["rev-parse", "HEAD"]);
  }

  async revParse(ref: string): Promise<string> {
    return this.run(["rev-parse", ref]);
  }

  async currentBranch(): Promise<string> {
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  async branchExists(branch: string): Promise<boolean> {
    const r = await this.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return r.code === 0;
  }

  /** Subject line of the latest commit on a ref. */
  async lastSubject(ref: string): Promise<string> {
    return this.run(["log", "-1", "--format=%s", ref]);
  }
}
