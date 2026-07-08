// Demo mode: a self-contained fleet SIMULATION that runs entirely in the browser.
// It overrides window.fetch so the real dashboard (index.html) renders against
// fabricated /api data — same markup, same code paths, same hydra — with no
// backend, repo, or agents. Nothing here labels itself as a demo; it just looks
// like a live fleet doing work.
//
// Everything is ASYNC: each task drives its own lifecycle through independent,
// randomly-timed setTimeout chains (spawn → work beats → resolve), so tasks
// progress and finish on their own staggered schedules rather than all moving on
// one global tick. Spawning and negotiations run on their own timers too.
//
// Fireworks note: the dashboard fires a fireworks "celebrate" on every
// running->completed transition, and paints completed+integrating heads "disco".
// To keep the demo calm we never surface a `completed` worker state or an
// `integrating` flag — tasks resolve straight to `merged`, so their heads simply
// puff away (a plain despawn). Tasks never fail. Head tangling during a
// negotiation still comes through, since that's driven by integration steps.
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
  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (a) => a[rint(a.length)];
  const shuffle = (a) => a.slice().sort(() => Math.random() - 0.5);
  function sha() { let s = ""; for (let i = 0; i < 40; i++) s += HEX[rint(16)]; return s; }
  const nowISO = () => new Date().toISOString();
  const agoISO = (secs) => new Date(Date.now() - secs * 1000).toISOString();
  const words = (branch) => branch.split("/").slice(1).join("/").replace(/-/g, " ");
  const after = (ms, fn) => setTimeout(fn, ms); // one-shot; each task chains its own

  // ------------------------------------------------------------------ state
  const repoRoot = "~/code/acme-platform";
  let repoBranch = "main";
  let sessionTarget = "";           // integration target (blank => main)
  let workers = [];                 // the fleet (see makeWorker)
  let integration = null;           // rolling merge-train record for the panel
  const checkpoints = [];           // recent resolved-task checkpoints (rolling)
  const commitLog = [];             // newest-first {hash, parents, subject}
  const tips = {};                  // branch -> tip hash
  const paused = {};                // branch -> true
  let nego = null;                  // active negotiation: {branches, step}
  let idc = 0;
  let supervisorUntil = 0;          // wall-clock ms until which a planning session shows

  // seed a little trunk history
  (function seed() {
    const subs = ["Initial import", "Set up CI", "Add lint + format", "Wire the router", "Base DB schema", "Add dashboard shell"];
    let prev = null;
    for (const sub of subs) { const h = sha(); commitLog.unshift({ hash: h, parents: prev ? [prev] : [], subject: sub }); prev = h; }
    tips.main = prev;
  })();

  const publicWorker = (w) => ({
    taskId: w.taskId, branch: w.branch, worktree: w.worktree, state: w.state,
    head: w.head || undefined, checkpoint: w.checkpoint || undefined,
    priority: w.priority, targetBranch: w.targetBranch || undefined,
    updatedAt: w.updatedAt, lastActivityAt: w.lastActivityAt || undefined, merged: w.merged,
  });
  const live = () => workers.filter((w) => !w.merged);

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

  // Merge a resolved branch into the trunk (advances main; the branch ref folds in).
  function landOnMain(w) {
    const h = sha();
    commitLog.unshift({ hash: h, parents: [tips.main, w.head].filter(Boolean), subject: `Merge ${w.branch} into main` });
    if (commitLog.length > 44) commitLog.length = 44;
    tips.main = h;
    return h;
  }

  function mergeStep(step) {
    if (!integration) integration = { promoted: true, mainHead: tips.main, steps: [], warning: undefined, updatedAt: nowISO() };
    integration.steps.push(step);
    if (integration.steps.length > 8) integration.steps = integration.steps.slice(-8);
    integration.mainHead = tips.main;
    integration.promoted = true;
    return step;
  }

  // -------------------------------------------------------- task lifecycle
  function makeWorker(topic) {
    const branch = uniqueBranch(topic);
    return {
      taskId: "t" + (++idc), branch, desc: `${pick(VERB)} ${topic.replace(/-/g, " ")}`,
      state: "pending", head: null, priority: 1 + rint(4),
      targetBranch: sessionTarget || (Math.random() < 0.25 ? `release/v${2 + rint(4)}` : "") || undefined,
      worktree: `${repoRoot}/.harness/worktrees/${branch.replace(/\//g, "_")}`,
      checkpoint: null, updatedAt: nowISO(), lastActivityAt: null,
      merged: false, _commits: 0, _ctx: "", _budget: 0, _gone: false, _nego: false,
    };
  }

  function spawnTask(w) {
    w = w || makeWorker(pick(TOPIC));
    workers.push(w);
    supervisorUntil = Date.now() + rand(3000, 6000);
    after(rand(600, 2200), () => beginWork(w)); // pending -> running after its own delay
    return w;
  }

  function beginWork(w) {
    if (w._gone || w.merged) return;
    w.state = "running";
    commitOn(w); w.lastActivityAt = nowISO(); w.updatedAt = nowISO();
    w._budget = 2 + rint(5); // work commits before it may resolve — varies per task
    scheduleBeat(w);
  }

  function scheduleBeat(w) { after(rand(1900, 4300), () => workBeat(w)); }

  function workBeat(w) {
    if (w._gone || w.merged) return;
    if (w._nego) { scheduleBeat(w); return; } // paused while its branch negotiates
    if (Math.random() < 0.18) { w.lastActivityAt = agoISO(140); w.updatedAt = nowISO(); } // doze -> sleepy head
    else { commitOn(w); w.lastActivityAt = nowISO(); w.updatedAt = nowISO(); w._budget--; }
    if (w._budget <= 0 && Math.random() < 0.55) { resolve(w); return; }
    scheduleBeat(w);
  }

  // Resolve a task: it lands on the trunk and its head puffs away (a plain despawn,
  // never a fireworks "completed"). `viaNego` skips a fresh merge step (the
  // negotiation already recorded a `resolved` one).
  function resolve(w, viaNego) {
    if (w.merged) return;
    w._ctx = w._ctx || pick(CTX);
    w.checkpoint = "cp/" + w.branch;
    landOnMain(w);
    w.state = "merged"; w.merged = true; w._nego = false; w.updatedAt = nowISO();
    checkpoints.unshift({ branch: w.branch, head: w.head, context: w._ctx, description: w.desc, createdAt: w.updatedAt, taskId: w.taskId });
    if (checkpoints.length > 6) checkpoints.length = 6;
    if (!viaNego) mergeStep({ branch: w.branch, status: "merged" });
    after(rand(700, 1400), () => { w._gone = true; workers = workers.filter((x) => x !== w); });
  }

  // ---------------------------------------------------------- negotiations
  function startNego() {
    const cands = live().filter((w) => w.state === "running" && !w._nego);
    if (cands.length < 2) return;
    const size = Math.min(cands.length, 2 + (Math.random() < 0.4 ? 1 : 0));
    const group = shuffle(cands).slice(0, size);
    group.forEach((w) => { w._nego = true; w.lastActivityAt = nowISO(); w.updatedAt = nowISO(); });
    const step = mergeStep({ branch: group[0].branch, status: "negotiating", negotiatingWith: group.slice(1).map((w) => w.branch), detail: `resolving conflict in ${pick(FILES)}` });
    nego = { branches: group.map((w) => w.branch), step };
    after(rand(3000, 6500), finishNego);
  }

  function finishNego() {
    if (!nego) return;
    nego.step.status = "resolved";
    nego.step.detail = `merged ${pick(FILES)} keeping both sides`;
    for (const b of nego.branches) {
      const w = workers.find((x) => x.branch === b && !x.merged);
      if (w) resolve(w, true);
    }
    integration.mainHead = tips.main;
    integration.updatedAt = nowISO(); // a train landed — fine to ring once
    nego = null;
  }

  // ------------------------------------------------- background schedulers
  function spawnLoop() {
    after(rand(2500, 5500), () => {
      const active = live().filter((w) => w.state === "pending" || w.state === "running").length;
      if (active < 3 || (active < 6 && Math.random() < 0.6)) spawnTask();
      spawnLoop();
    });
  }
  function negoLoop() {
    after(rand(9000, 19000), () => { if (!nego) startNego(); negoLoop(); });
  }

  for (let i = 0; i < 4; i++) after(rand(0, 2500), () => spawnTask()); // stagger the initial fleet
  spawnLoop();
  negoLoop();

  // -------------------------------------------------------------- responses
  function statusPayload() {
    const nonMerged = live();
    const worktrees = [{ branch: repoBranch }].concat(
      nonMerged.filter((w) => w.state === "running" || w.state === "pending").map((w) => ({ branch: w.branch }))
    );
    const inbox = {};
    for (const b in paused) if (paused[b]) inbox[b] = { paused: true, count: 0 };
    return {
      repoRoot, generatedAt: nowISO(),
      workers: workers.map(publicWorker),
      worktrees, checkpoints, integration,
      inbox, repo: { branch: repoBranch, mainBranch: "main", dirty: false, changes: 0 },
      integrating: false, // never true — that (with a completed head) is what lights fireworks
    };
  }

  function gitgraphPayload() {
    const refByHash = {};
    const add = (h, r) => { if (!h) return; refByHash[h] = refByHash[h] ? refByHash[h] + ", " + r : r; };
    for (const w of workers) if (!w.merged && w.head && w.state === "running") add(w.head, w.branch);
    add(tips.main, "main");
    return {
      commits: commitLog.slice(0, 40).map((c) => ({
        hash: c.hash, parents: c.parents, refs: refByHash[c.hash] || "", subject: c.subject,
      })),
    };
  }

  function agentsPayload() {
    const list = [];
    if (nego) list.push({ id: "sess-negotiator", role: "negotiator", branch: nego.branches[0], title: "resolving merge conflicts on the train", lastActivityAt: nowISO() });
    if (Date.now() < supervisorUntil) list.push({ id: "sess-supervisor", role: "supervisor", branch: "", title: "planning the fleet split", lastActivityAt: nowISO() });
    live().filter((w) => w.state === "running").forEach((w) => {
      list.push({ id: "sess-" + w.taskId, role: "worker", branch: w.branch, title: w.desc, lastActivityAt: w.lastActivityAt || w.updatedAt });
    });
    return { agents: list };
  }

  function transcriptFor(key, isAgent) {
    const w = isAgent
      ? workers.find((x) => "sess-" + x.taskId === key)
      : workers.find((x) => x.branch === key);
    const base = Date.now() - 60000;
    const at = (i) => new Date(base + i * 9000).toISOString();
    const desc = w ? w.desc : "work on this branch";
    const evs = [
      { ts: at(0), kind: "user", text: desc + " — commit incrementally." },
      { ts: at(1), kind: "thinking", text: pick(THINK) },
      { ts: at(2), kind: "tool", text: pick(TOOLS) },
      { ts: at(3), kind: "assistant", text: "Made the change and committed. Moving to the next step." },
      { ts: at(4), kind: "tool", text: pick(TOOLS) },
    ];
    if (w && w._nego) evs.push({ ts: at(5), kind: "thinking", text: "Reconciling with a conflicting branch on the train…" });
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
      const w = makeWorker(pick(TOPIC));
      if (body.branch) { w.branch = sanTarget(body.branch); w.worktree = `${repoRoot}/.harness/worktrees/${w.branch.replace(/\//g, "_")}`; }
      if (body.description) w.desc = String(body.description).slice(0, 60);
      if (sessionTarget) w.targetBranch = sessionTarget;
      spawnTask(w);
      supervisorUntil = Date.now() + 4000;
      return { ok: true, planning: true };
    }
    if (p === "/api/integrate") {
      if (body.into) sessionTarget = sanTarget(body.into);
      if (!nego) startNego();
      return { ok: true, started: true };
    }
    if (p === "/api/session") { sessionTarget = sanTarget(body.targetBranch); return { ok: true, targetBranch: sessionTarget || null }; }
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
      const branches = Array.from(new Set(["main"].concat(live().map((w) => w.branch))));
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
