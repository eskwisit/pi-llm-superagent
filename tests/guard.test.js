"use strict";

// The Task guard extension: while a ticket turn runs, a Task call must match its launch item.
// The state with a running turn comes from the real main.js (accept → launch), not from a fixture.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const { ROOT, loadMain, sandbox, fakePi, put, get, withHome } = require("./helpers.js");

const MODELS = [
  { key: "anthropic/claude-opus-5-5", providerId: "anthropic", providerName: "Anthropic", modelId: "claude-opus-5-5", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
  { key: "google/gemini-3.8-flash", providerId: "google", providerName: "Google", modelId: "gemini-3.8-flash", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
];
const STATE = ".superagent/state.json";

let dirs, restore, launch, handler;
const call = (input, toolName = "Task") => handler({ toolName, input, toolCallId: "c1" }, { cwd: dirs.workspace });
const setState = (fn) => {
  const s = JSON.parse(get(dirs, STATE));
  put(dirs, STATE, JSON.stringify(fn(s) || s));
};

before(async () => {
  dirs = sandbox();
  restore = withHome(dirs.home);
  const pi = fakePi(dirs, { settings: { isolation: "serial" }, models: MODELS });
  const main = loadMain(pi);
  await main.onLoad();
  await pi.call("superagent", {});
  const intake = await pi.call("superagent_intake", { text: "Fix the login timeout in auth.ts" });
  const route = await pi.call("superagent_route", { decisions: [{ kind: "accept", trigger_id: intake.trigger_id, title: "Fix the login timeout", name: "login timeout", type: "debug", acknowledgement: "On it: fixing the login timeout in auth.ts." }] });
  launch = route.launch[0];
  assert.equal(launch.agent, "superagent-writer");
  const ext = await import(url.pathToFileURL(path.join(ROOT, "extension", "superagent-guard.js")).href);
  const handlers = new Map();
  ext.default({ on: (name, fn) => handlers.set(name, fn) });
  handler = handlers.get("tool_call");
  assert.ok(handler);
});
after(() => {
  restore();
  fs.rmSync(dirs.base, { recursive: true, force: true });
});

const good = () => ({ agent: launch.agent, model: launch.model, task: launch.task, description: `${launch.ticket} #${launch.turn}` });

describe("superagent guard", () => {
  it("the real state has a running turn in the shape the guard reads", () => {
    const t = JSON.parse(get(dirs, STATE)).tickets[launch.ticket];
    const a = t.assignments.find((x) => x.turns.some((turn) => turn.state === "running"));
    assert.equal(a.model, launch.model);
    assert.equal(a.turns[0].brief, `.superagent/tickets/${launch.ticket}/turn-1.md`);
    assert.ok(launch.task.includes(a.turns[0].brief));
  });

  it("allows a Task that matches the launch item", async () => {
    assert.equal(await call(good()), undefined);
  });

  it("allows a Task found by its brief path when the description is free text", async () => {
    assert.equal(await call({ ...good(), description: "fixing login" }), undefined);
  });

  it("blocks a generic sub-agent", async () => {
    const r = await call({ agent: "explorer", task: "look around", description: "x" });
    assert.equal(r.block, true);
    assert.match(r.reason, /generic sub-agents never run a ticket/);
  });

  it("blocks the wrong model, missing included", async () => {
    const r = await call({ ...good(), model: "google/gemini-3.8-flash" });
    assert.match(r.reason, new RegExp(`pass model: "${launch.model}"`));
    assert.equal((await call({ ...good(), model: undefined })).block, true);
  });

  it("blocks the wrong worker for the ticket type", async () => {
    const r = await call({ ...good(), agent: "superagent-reader" });
    assert.match(r.reason, /is a debug ticket: launch agent superagent-writer/);
  });

  it("blocks a Task with an unknown description and no brief in its task, naming the running turns", async () => {
    const r = await call({ ...good(), description: "other #9", task: "do something else" });
    assert.equal(r.block, true);
    assert.match(r.reason, new RegExp(`${launch.ticket} #${launch.turn} \\(\\.superagent/tickets/${launch.ticket}/turn-1\\.md\\)`));
  });

  it("blocks a matched turn whose task is not the brief, unless it resumes", async () => {
    const r = await call({ ...good(), task: "fix the timeout please" });
    assert.match(r.reason, /task must be the launch item's task verbatim: Read your brief at/);
    assert.equal(await call({ ...good(), task: "continue", resume: "d1" }), undefined);
  });

  it("leaves other agents and other tools alone", async () => {
    assert.equal(await call({ agent: "some-other-agent", task: "x" }), undefined);
    assert.equal(await call({ agent: "explorer", task: "x" }, "Read"), undefined);
  });

  it("allows everything with invalid JSON or no state", async () => {
    const saved = get(dirs, STATE);
    put(dirs, STATE, "{ not json");
    assert.equal(await call({ agent: "explorer", task: "x" }), undefined);
    fs.rmSync(path.join(dirs.workspace, STATE));
    assert.equal(await call({ agent: "explorer", task: "x" }), undefined);
    put(dirs, STATE, saved);
  });

  it("is idle once no turn runs", async () => {
    const saved = get(dirs, STATE);
    setState((s) => { for (const t of Object.values(s.tickets)) for (const a of t.assignments) for (const turn of a.turns) turn.state = "ended"; });
    assert.equal(await call({ agent: "explorer", task: "x" }), undefined);
    put(dirs, STATE, saved);
  });
});
