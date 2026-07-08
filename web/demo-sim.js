// Demo mode: a self-contained, slow-paced fleet SIMULATION that runs entirely in
// the browser. It overrides window.fetch so the real dashboard (index.html) renders
// against fabricated /api data — same markup, same code paths, same hydra — with no
// backend, repo, or agents. Nothing here labels itself as a demo; it just looks like
// a live fleet doing work.
(function () {
  "use strict";
  if (window.__HARNESS_DEMO__) return;
  window.__HARNESS_DEMO__ = true;

  // ------------------------------------------------------------------ vocab
  const VERB = ["Add", "Fix", "Refactor", "Improve", "Harden", "Speed up", "Rework", "Simplify"];
  const TOPIC = [
    "user-auth", "csv-export", "dark-mode", "rate-limiter", "search-index", "webhook-retry",
    "session-cache", "oauth-login", "audit-log", "graphql-api", "image-resize", "pagination",
    "feature-flags", "email-digest", "billing-proration", "drag-drop", "sql-migrations",
    "push-notifs", "profile-page", "csrf-guard", "batch-jobs", "log-shipping",
  ];
  const WIP = ["wip", "checkpoint", "progress", "refactor", "tests", "cleanup", "fixup"];
  const FILES = [
    "src/api/router.ts", "src/db/schema.sql", "package.json", "src/auth/session.ts",
    "src/ui/App.tsx", "src/config.ts", "src/server.ts", "src/lib/cache.ts",
  ];
  const CTX = [
    "Extracted a helper and kept the public API stable.",
    "Added unit tests for the new path; all green.",
    "Split the module along the file boundary to avoid overlap.",
    "Handled the empty-input edge case and documented it.",
    "Wired the feature behind a flag; default off.",
    "Migrated callers and removed the deprecated shim.",
  ];
  const THINK = [
    "Reading the surrounding module to match its conventions…",
    "This touches the shared router — keeping the change scoped.",
    "Writing a focused test before the implementation.",
    "Committing incrementally so integration stays easy.",
    "Double-checking I'm inside my own worktree.",
  ];
  const TOOLS = [
    "$ git add -A && git commit -m 'wip'", "$ npm test -- --run", "$ rg 'export function'",
    "edit src/… (+18 −4)", "$ tsc --noEmit", "read src/server.ts",
  ];

  const HEX = "0123456789abcdef";
  const rint = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rint(a.length)];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function sha() { let s = ""; for (let i = 0; i < 40; i++) s += HEX[rint(16)]; return s; }
  const nowISO = () => new Date().toISOString();
  const agoISO = (secs) => new Date(Date.now() - secs * 1000).toISOString();
  const words = (branch) => branch.split("/").slice(1).join("/").replace(/-/g, " ");

  // ------------------------------------------------------------------ state
  const repoRoot = "~/code/acme-platform";
  let repoBranch = "main";
  let sessionTarget = "";           // integration target (blank => main)
  let workers = [];                 // fleet
  let integration = null;           // last/current integration result
  let integrating = false;
  const commitLog = [];             // newest-first {hash, parents, subject}
  const tips = {};                  // branch -> tip hash
  const paused = {};                // branch -> true
  let idc = 0, tick = 0;
  let clearAt = null;               // when to sweep merged workers after a promotion
  let supervisorUntil = 0;          // show a "fleet planning" session for a bit

  // integration sub-state
  let iQueue = [], iStaged = [], negoActive = false, negoWorker = null;

  // seed a little trunk history
  (function seed() {
    const subs = ["Initial import", "Set up CI", "Add lint + format", "Wire the router", "Base DB schema", "Add dashboard shell"];
    let prev = null;
    for (const sub of subs) { const h = sha(); commitLog.unshift({ hash: h, parents: prev ? [prev] : [], subject: sub }); prev = h; }
    tips.main = prev;
  })();

  const publicWorker = (w) => ({
    taskId: w.taskId, branch: w.branch, worktree: w.worktree, state: w.state,
    head: w.head || undefined, error: w.error || undefined, checkpoint: w.checkpoint || undefined,
    priority: w.priority, targetBranch: w.targetBranch || undefined,
    updatedAt: w.updatedAt, lastActivityAt: w.lastActivityAt || undefined, merged: w.merged,
  });

  function uniqueBranch(topic) {
    let b = `${pick(["feat", "fix", "refactor", "perf", "chore"])}/${topic}`;
    let n = 2;
    const taken = new Set(workers.map((w) => w.branch));
    while (taken.has(b)) b = `${b}-${n++}`;
    return b;
  }

  function commitOn(w) {
    const base = w.head || tips.main;
    const h = sha();
    const subject = w._commits === 0 ? `wip: ${w.desc.toLowerCase()}` : `${pick(WIP)}: ${words(w.branch)}`;
    commitLog.unshift({ hash: h, parents: [base], subject });
    if (commitLog.length > 44) commitLog.length = 44;
    w.head = h; w._commits++;
    return h;
  }

  function promote(target, staged) {
    const h = sha();
    const parents = [tips[target] || tips.main, ...staged.map((w) => w.head).filter(Boolean)];
    commitLog.unshift({ hash: h, parents, subject: `Merge fleet (${staged.length} branch${staged.length !== 1 ? "es" : ""}) into ${target}` });
    if (commitLog.length > 44) commitLog.length = 44;
    tips[target] = h;
    if (target === "main") tips.main = h;
    return h;
  }

  function spawnFleet() {
    const size = 2 + rint(3); // 2..4
    if (!sessionTarget && Math.random() < 0.4) sessionTarget = `release/v${2 + rint(4)}`;
    const target = sessionTarget || "";
    const pool = TOPIC.slice();
    for (let i = 0; i < size; i++) {
      const topic = pool.splice(rint(pool.length), 1)[0] || pick(TOPIC);
      const branch = uniqueBranch(topic);
      workers.push({
        taskId: "t" + (++idc), branch, desc: `${pick(VERB)} ${topic.replace(/-/g, " ")}`,
        state: "pending", head: null, priority: i + 1, targetBranch: target || undefined,
        worktree: `${repoRoot}/.harness/worktrees/${branch.replace(/\//g, "_")}`,
        checkpoint: null, error: null, updatedAt: nowISO(), lastActivityAt: null,
        merged: false, _commits: 0, _work: 0, _ctx: "",
      });
    }
    supervisorUntil = tick + 3;
  }

  function startIntegration(completed) {
    integrating = true;
    clearAt = null;
    iQueue = completed.slice().sort((a, b) => (a.priority || 9) - (b.priority || 9));
    iStaged = []; negoActive = false; negoWorker = null;
    integration = { promoted: false, mainHead: undefined, steps: [], warning: undefined, updatedAt: nowISO() };
  }

  function advanceIntegration() {
    const target = sessionTarget || "main";
    if (negoActive) {
      // resolve the pending negotiation (heads untangle, branch lands)
      const step = integration.steps[integration.steps.length - 1];
      step.status = "resolved";
      step.detail = `merged ${pick(FILES)} keeping both sides`;
      iStaged.push(negoWorker);
      negoActive = false; negoWorker = null;
      integration.updatedAt = nowISO();
      return;
    }
    if (iQueue.length) {
      const w = iQueue.shift();
      if (iStaged.length > 0 && Math.random() < 0.5) {
        // conflict: this branch tangles with the already-staged counterparties
        integration.steps.push({
          branch: w.branch, status: "negotiating",
          negotiatingWith: iStaged.map((x) => x.branch).slice(-2),
          detail: `resolving conflict in ${pick(FILES)}`,
        });
        negoActive = true; negoWorker = w;
      } else {
        integration.steps.push({ branch: w.branch, status: "merged" });
        iStaged.push(w);
      }
      integration.updatedAt = nowISO();
      return;
    }
    // everything staged -> promote and fold the branches in
    const head = promote(target, iStaged);
    integration.promoted = true;
    integration.mainHead = head;
    integration.updatedAt = nowISO();
    iStaged.forEach((w) => { w.merged = true; w.updatedAt = nowISO(); });
    if (target !== "main") repoBranch = "main"; // stay on trunk
    integrating = false;
    clearAt = tick + 3; // linger so the promoted result stays on screen a moment
    sessionTarget = ""; // next fleet picks a fresh target
  }

  // ------------------------------------------------------------- sim clock
  function step() {
    tick++;
    const nonMerged = workers.filter((w) => !w.merged);

    // sweep merged workers a few ticks after a promotion, then the fleet refills
    if (!integrating && clearAt != null && tick >= clearAt) {
      workers = workers.filter((w) => !w.merged);
      clearAt = null;
    }

    // refill when idle
    if (!integrating && clearAt == null && workers.filter((w) => !w.merged).length === 0) {
      spawnFleet();
      return; // let them render as pending first
    }

    // advance each worker's lifecycle
    for (const w of nonMerged) {
      if (w.state === "pending") {
        if (Math.random() < 0.85) { w.state = "running"; commitOn(w); w.lastActivityAt = nowISO(); w.updatedAt = nowISO(); }
      } else if (w.state === "running") {
        w._work++;
        // rare stall: the head dozes (sleepy) and picks up an idle badge
        if (Math.random() < 0.12) { w.lastActivityAt = agoISO(140); }
        else if (Math.random() < 0.06) { w.state = "failed"; w.error = "test gate failed"; w.updatedAt = nowISO(); continue; }
        else { commitOn(w); w.lastActivityAt = nowISO(); w.updatedAt = nowISO(); }
        if (w._work >= 2 && Math.random() < 0.4) {
          w.state = "completed"; w._ctx = pick(CTX); w.checkpoint = "cp/" + w.branch; w.lastActivityAt = nowISO(); w.updatedAt = nowISO();
        }
      }
    }

    // once the round is terminal, integrate what completed (or clear a dead round)
    if (!integrating) {
      const live = workers.filter((w) => !w.merged && (w.state === "pending" || w.state === "running"));
      const completed = workers.filter((w) => !w.merged && w.state === "completed");
      if (live.length === 0 && clearAt == null) {
        if (completed.length >= 1) startIntegration(completed);
        else if (workers.some((w) => !w.merged)) workers = workers.filter((w) => w.merged); // only failures — reset
      }
    } else {
      advanceIntegration();
    }
  }

  const STEP_MS = 4500; // deliberately slow — a calm, watchable pace
  spawnFleet();
  setInterval(step, STEP_MS);

  // -------------------------------------------------------------- responses
  function statusPayload() {
    const nonMerged = workers.filter((w) => !w.merged);
    const worktrees = [{ branch: repoBranch }].concat(
      nonMerged.filter((w) => w.state === "running" || w.state === "pending").map((w) => ({ branch: w.branch }))
    );
    const checkpoints = workers.filter((w) => w.checkpoint).map((w) => ({
      branch: w.branch, head: w.head, context: w._ctx, description: w.desc, createdAt: w.updatedAt, taskId: w.taskId,
    }));
    const inbox = {};
    for (const b in paused) if (paused[b]) inbox[b] = { paused: true, count: 0 };
    return {
      repoRoot, generatedAt: nowISO(),
      workers: workers.map(publicWorker),
      worktrees, checkpoints, integration,
      inbox, repo: { branch: repoBranch, mainBranch: "main", dirty: false, changes: 0 },
      integrating,
    };
  }

  function gitgraphPayload() {
    const refByHash = {};
    const add = (h, r) => { if (!h) return; refByHash[h] = refByHash[h] ? refByHash[h] + ", " + r : r; };
    for (const w of workers) {
      if (!w.merged && w.head && (w.state === "running" || w.state === "completed" || w.state === "failed")) add(w.head, w.branch);
    }
    for (const t in tips) if (t !== "main") add(tips[t], t);
    add(tips.main, "main");
    return {
      commits: commitLog.slice(0, 40).map((c) => ({
        hash: c.hash, parents: c.parents, refs: refByHash[c.hash] || "", subject: c.subject,
      })),
    };
  }

  function agentsPayload() {
    const list = [];
    if (integrating) {
      const negoBranch = (integration.steps.find((s) => s.status === "negotiating") || {}).branch;
      list.push({ id: "sess-negotiator", role: "negotiator", branch: negoBranch || "", title: "resolving merge conflicts on the train", lastActivityAt: nowISO() });
    }
    if (tick <= supervisorUntil) {
      list.push({ id: "sess-supervisor", role: "supervisor", branch: "", title: "planning the fleet split", lastActivityAt: nowISO() });
    }
    workers.filter((w) => !w.merged && w.state !== "pending").forEach((w) => {
      list.push({ id: "sess-" + w.taskId, role: "worker", branch: w.branch, title: w.desc, lastActivityAt: w.lastActivityAt || w.updatedAt });
    });
    return { agents: list };
  }

  function transcriptFor(key, isAgent) {
    const w = isAgent
      ? workers.find((x) => "sess-" + x.taskId === key)
      : workers.find((x) => x.branch === key);
    const evs = [];
    const base = Date.now() - 60000;
    const at = (i) => new Date(base + i * 9000).toISOString();
    const desc = w ? w.desc : "work on this branch";
    evs.push({ ts: at(0), kind: "user", text: desc + " — commit incrementally." });
    evs.push({ ts: at(1), kind: "thinking", text: pick(THINK) });
    evs.push({ ts: at(2), kind: "tool", text: pick(TOOLS) });
    evs.push({ ts: at(3), kind: "assistant", text: "Made the change and committed. Moving to the next step." });
    evs.push({ ts: at(4), kind: "tool", text: pick(TOOLS) });
    if (w && w.state === "completed") evs.push({ ts: at(5), kind: "assistant", text: "Done — " + (w._ctx || "task complete.") });
    return evs;
  }

  function tasksPayload(q) {
    const terms = (q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = workers.map((w) => ({ branch: w.branch, taskId: w.taskId, state: w.merged ? "completed" : w.state, description: w.desc, updatedAt: w.updatedAt }));
    const matched = terms.length ? all.filter((t) => terms.every((k) => (t.branch + " " + t.description).toLowerCase().includes(k))) : all;
    return { tasks: matched.slice(0, 50) };
  }

  const sanTarget = (b) => String(b == null ? "" : b).trim().replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/^-+|-+$/g, "");

  // --------------------------------------------------------- POST handlers
  function handlePost(p, body) {
    if (p === "/api/spawn") {
      if (body.targetBranch !== undefined) sessionTarget = sanTarget(body.targetBranch);
      const topic = (body.branch && sanTarget(body.branch)) || pick(TOPIC);
      const branch = body.branch ? sanTarget(body.branch) : uniqueBranch(topic);
      workers.push({
        taskId: "t" + (++idc), branch, desc: (body.description || "New task").slice(0, 60),
        state: "pending", head: null, priority: 1, targetBranch: sessionTarget || undefined,
        worktree: `${repoRoot}/.harness/worktrees/${branch.replace(/\//g, "_")}`,
        checkpoint: null, error: null, updatedAt: nowISO(), lastActivityAt: null,
        merged: false, _commits: 0, _work: 0, _ctx: "",
      });
      supervisorUntil = tick + 3;
      return { ok: true, planning: true };
    }
    if (p === "/api/integrate") {
      if (body.into) sessionTarget = sanTarget(body.into);
      const completed = workers.filter((w) => !w.merged && w.state === "completed");
      if (!integrating && completed.length) startIntegration(completed);
      return { ok: true, started: true };
    }
    if (p === "/api/session") {
      sessionTarget = sanTarget(body.targetBranch);
      return { ok: true, targetBranch: sessionTarget || null };
    }
    if (p === "/api/control") {
      if (body.action === "pause") paused[body.branch] = true;
      else if (body.action === "resume") delete paused[body.branch];
      return { ok: true };
    }
    if (p === "/api/checkout") { repoBranch = sanTarget(body.branch) || repoBranch; return { ok: true, branch: repoBranch }; }
    if (p === "/api/delete-branch") { workers = workers.filter((w) => w.branch !== sanTarget(body.branch)); return { ok: true, branch: body.branch }; }
    if (p === "/api/extend") return { ok: true, mode: "continued" };
    if (p === "/api/inject") return { ok: true };
    if (p === "/api/stash") return { ok: true, detail: "saved working tree" };
    if (p === "/api/config") return { ok: true, config: { prompts: {}, models: {} } };
    return { ok: true };
  }

  function handleGet(p, u) {
    if (p === "/api/status") return statusPayload();
    if (p === "/api/gitgraph") return gitgraphPayload();
    if (p === "/api/agents") return agentsPayload();
    if (p === "/api/branches") return { branches: [] };
    if (p === "/api/tasks") return tasksPayload(u.searchParams.get("q"));
    if (p === "/api/session") {
      const branches = Array.from(new Set(["main"].concat(workers.map((w) => w.branch)).concat(Object.keys(tips))));
      return { targetBranch: sessionTarget || null, trunk: "main", branches };
    }
    if (p === "/api/log") {
      const off = Number(u.searchParams.get("offset") || 0) || 0;
      const evs = transcriptFor(u.searchParams.get("branch") || "", false);
      return off >= evs.length ? { offset: evs.length, events: [] } : { offset: evs.length, events: evs.slice(off) };
    }
    if (p === "/api/agentlog") {
      const off = Number(u.searchParams.get("offset") || 0) || 0;
      const evs = transcriptFor(u.searchParams.get("id") || "", true);
      return off >= evs.length ? { offset: evs.length, events: [] } : { offset: evs.length, events: evs.slice(off) };
    }
    if (p === "/api/config") {
      return { config: { prompts: {}, models: {} }, roles: ["worker", "supervisor", "negotiator"], defaults: { worker: "", supervisor: "", negotiator: "" } };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------- fetch bridge
  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  const jsonResponse = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
  window.fetch = function (input, init) {
    let url = typeof input === "string" ? input : (input && input.url) || "";
    let u;
    try { u = new URL(url, location.origin); } catch (e) { u = null; }
    if (u && u.pathname.startsWith("/api/")) {
      const method = (init && init.method) || (typeof input === "object" && input.method) || "GET";
      let body = {};
      if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) {} }
      const out = method.toUpperCase() === "POST" ? handlePost(u.pathname, body) : handleGet(u.pathname, u);
      return Promise.resolve(jsonResponse(out));
    }
    return realFetch ? realFetch(input, init) : Promise.reject(new Error("fetch unavailable"));
  };

  // The only thing that would hint "demo": drop the demo nav link from this page.
  document.addEventListener("DOMContentLoaded", () => {
    const l = document.querySelector('a.navlink[href="/demo"]');
    if (l) l.remove();
  });
})();
