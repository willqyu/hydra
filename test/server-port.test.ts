import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

function boundPort(s: http.Server): number {
  const a = s.address();
  return typeof a === "object" && a ? a.port : -1;
}

async function waitListening(s: http.Server, timeoutMs = 3000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const p = boundPort(s);
    if (p > 0) return p;
    if (Date.now() - start > timeoutMs) throw new Error("server did not listen in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("startServer falls back to the next free port when the requested one is taken", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hydra-srv-"));
  // Occupy a port with a stand-in server that answers /api/whoami quickly.
  const blocker = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ repoRoot: "/some/other/repo" }));
  });
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const taken = boundPort(blocker);

  let srv: http.Server | undefined;
  try {
    srv = startServer({ repoRoot: repo, port: taken, host: "127.0.0.1", autoPort: true, logger: () => {} });
    const got = await waitListening(srv);
    assert.notEqual(got, taken, "should not bind the occupied port");
    assert.ok(got > taken, "should move to a higher free port");
  } finally {
    srv?.close();
    blocker.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test("startServer binds the requested port when it is free", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hydra-srv-"));
  // Grab a guaranteed-free port, release it, then ask the server for it.
  const probe = http.createServer(() => {});
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const wanted = boundPort(probe);
  await new Promise<void>((r) => probe.close(() => r()));

  let srv: http.Server | undefined;
  try {
    srv = startServer({ repoRoot: repo, port: wanted, host: "127.0.0.1", autoPort: true, logger: () => {} });
    const got = await waitListening(srv);
    assert.equal(got, wanted);
  } finally {
    srv?.close();
    await rm(repo, { recursive: true, force: true });
  }
});
