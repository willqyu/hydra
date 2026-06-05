import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFleetStatus } from "./status.js";
import { InboxManager, type InboxKind } from "./inbox.js";

export interface ServerOptions {
  repoRoot: string;
  port?: number;
  host?: string;
  logger?: (m: string) => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// web/ sits next to src/ in the repo, and next to dist/ when built.
const WEB_DIR = path.resolve(here, "..", "web");

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

      if (url.pathname === "/api/status") {
        const status = await readFleetStatus(opts.repoRoot);
        return send(res, 200, "application/json", JSON.stringify(status));
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(path.join(WEB_DIR, "index.html"), "utf8");
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
