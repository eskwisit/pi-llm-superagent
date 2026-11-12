"use strict";

// Quality checks: a test worker writes acceptance tests while the worker implements, a proof worker on another
// model checks quality and coherence, defects go back to their worker until the proof passes, then the merge.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadMain, sandbox, fakePi, put, get, withHome } = require("./helpers.js");

const MODELS = [
  { key: "anthropic/claude-opus-5-5", providerId: "anthropic", providerName: "Anthropic", modelId: "claude-opus-5-5", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
  { key: "google/gemini-3.8-pro", providerId: "google", providerName: "Google", modelId: "gemini-3.8-pro", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
];

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

async function setup(settings = {}) {
  const dirs = sandbox();
  const restore = withHome(dirs.home);
  cleanups.push(() => {
    restore();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
  const pi = fakePi(dirs, { settings: { isolation: "worktree", proofRounds: 3, ...settings }, models: MODELS });
  const main = loadMain(pi);
  await main.onLoad();
  await pi.call("superagent", {});
  const call = (name, args) => pi.call(`superagent_${name}`, args);
  const state = () => JSON.parse(get(dirs, ".superagent/state.json"));
  const brief = (ticket, n) => get(dirs, `.superagent/tickets/${ticket}/turn-${n}.md`);
  const report = async (ticket, n, text) => {
    put(dirs, `.superagent/tickets/${ticket}/report-${n}.md`, text);
    return call("ticket", { action: "report", ticket, turn: n });
  };
  return { dirs, call, state, brief, report };
}

const READY = "state: ready\nsummary: Done.\nhuman_action: none\nisolation: worktree\nmerge: yes\n---\nCommitted; tests pass.";
const proofSays = (verdict, extra = "") => `state: ready\nsummary: Proof ${verdict}.\nhuman_action: none\nverdict: ${verdict}\n${extra}---\nEvidence.`;
const one = (name, type = "code", extra = {}) => ({ kind: "accept", title: name, name, type, acknowledgement: `On it: ${name}.`, ...extra });

async function accept(env, text, decision) {
  const intake = await env.call("intake", { text });
  return env.call("route", { decisions: [{ ...decision, trigger_id: intake.trigger_id }] });
}
const tickets = (r) => (r.launch || []).map((x) => x.ticket).sort();

describe("checked tickets", () => {
  it("full: the test worker starts with the implementer, the proof waits for both, then the branches merge together", async () => {
    const env = await setup();
    const a = await accept(env, "Add a dark-mode toggle to the settings page.", one("dark toggle"));
    assert.deepEqual(tickets(a), ["dark-toggle", "dark-toggle-spec"], "implementation and acceptance tests in parallel");
    const s = env.state();
    const g = s.checks[s.tickets["dark-toggle"].check];
    assert.deepEqual(g.members, ["dark-toggle"]);
    assert.equal(g.spec, "dark-toggle-spec");
    assert.equal(s.tickets["dark-toggle-spec"].type, "spec");
    assert.match(env.brief("dark-toggle-spec", 1), /## Your job: acceptance checks[\s\S]*\.superagent\/tickets\/dark-toggle-spec\/checklist\.md/);
    assert.match(env.brief("dark-toggle-spec", 1), /> Add a dark-mode toggle/, "the test worker reads the request");
    assert.match(env.brief("dark-toggle", 1), /## Quality check[\s\S]*Ticket dark-toggle-spec writes acceptance tests/);

    const r1 = await env.report("dark-toggle", 1, READY);
    assert.equal(r1.handoff.kind, "none");
    assert.match(r1.note, /held for its proof/);
    assert.equal(r1.stage, "working/proof");
    assert.equal(r1.launch, undefined, "the proof waits for the acceptance tests");
    const r2 = await env.report("dark-toggle-spec", 1, READY);
    assert.deepEqual(tickets(r2), ["dark-toggle-proof"]);
    const p = r2.launch[0];
    assert.equal(p.agent, "superagent-reader");
    assert.equal(p.model, "google/gemini-3.8-pro", "another model family than the implementer");
    const pb = env.brief("dark-toggle-proof", 1);
    assert.match(pb, /proof worker/);
    assert.match(pb, /git worktree add --detach \.superagent\/worktrees\/dark-toggle-proof superagent\/dark-toggle/);
    assert.match(pb, /git diff --binary refs\/superagent\/base\/dark-toggle-spec superagent\/dark-toggle-spec \| git apply --3way/);
    assert.match(pb, /\*\*Coherence\.\*\*/);
    assert.match(pb, /^verdict: <pass \| fail>/m);

    const r3 = await env.report("dark-toggle-proof", 1, proofSays("pass"));
    assert.equal(r3.handoff.kind, "none");
    assert.match(r3.note, /proof passed/);
    assert.deepEqual(tickets(r3), ["merge"]);
    const after = env.state();
    assert.deepEqual(after.tickets.merge.merges.sort(), ["dark-toggle", "dark-toggle-spec"], "the tests land with the work");
    assert.equal(after.tickets["dark-toggle-proof"].ended.outcome, "completed");
    assert.equal(after.checks[g.id].state, "passed");
  });

  it("fail: each defect goes back to its worker as a fix turn, and the proof runs again on the fixed work", async () => {
    const env = await setup();
    await accept(env, "Add a dark-mode toggle.", one("dark toggle"));
    await env.report("dark-toggle", 1, READY);
    await env.report("dark-toggle-spec", 1, READY);
    const f = await env.report("dark-toggle-proof", 1, proofSays("fail", "bugs: dark-toggle: the toggle is not saved, settings.ts:42, run npm test -- toggle\nspec_bugs: none\n"));
    assert.match(f.note, /round 1 failed: defects went back to dark-toggle/);
    assert.deepEqual(tickets(f), ["dark-toggle"]);
    const fb = env.brief("dark-toggle", 2);
    assert.match(fb, /\*\*Fix\.\*\*/);
    assert.match(fb, /the toggle is not saved, settings\.ts:42/);
    assert.equal(env.state().tickets["dark-toggle-spec"].hold.state, "proof", "the tests keep waiting");
    const again = await env.report("dark-toggle", 2, READY);
    assert.deepEqual(tickets(again), ["dark-toggle-proof"], "round 2 on the same proof ticket");
    assert.match(env.brief("dark-toggle-proof", 2), /Proof round 2 of at most 3/);
    assert.match(env.brief("dark-toggle-proof", 2), /\[NEW\][^\n]*Round 2/);
  });

  it("a wrong acceptance test goes back to the test worker", async () => {
    const env = await setup();
    await accept(env, "Add a dark-mode toggle.", one("dark toggle"));
    await env.report("dark-toggle", 1, READY);
    await env.report("dark-toggle-spec", 1, READY);
    const f = await env.report("dark-toggle-proof", 1, proofSays("fail", "bugs: none\nspec_bugs: toggle.test.ts assumes the name darkMode; the request leaves it open and the work uses theme\n"));
    assert.deepEqual(tickets(f), ["dark-toggle-spec"]);
    assert.match(env.brief("dark-toggle-spec", 2), /assumes the name darkMode/);
    assert.equal(env.state().tickets["dark-toggle"].hold.state, "proof");
  });

  it("when the rounds are used up the branches stay unmerged and the person decides", async () => {
    const env = await setup({ proofRounds: 1 });
    await accept(env, "Add a dark-mode toggle.", one("dark toggle"));
    await env.report("dark-toggle", 1, READY);
    await env.report("dark-toggle-spec", 1, READY);
    const f = await env.report("dark-toggle-proof", 1, proofSays("fail", "bugs: dark-toggle: not saved\n"));
    assert.equal(f.handoff.kind, "blocker");
    assert.match(f.handoff.summary, /still fails its proof after 1 rounds/);
    const s = env.state();
    assert.equal(s.tickets["dark-toggle"].merge.state, "unmerged");
    assert.equal(s.tickets["dark-toggle"].hold, undefined);
    const m = await env.call("ticket", { action: "merge" });
    assert.deepEqual(m.queued.sort(), ["dark-toggle", "dark-toggle-spec"], "merge anyway");
  });

  it("several requests of one message share one test worker and one proof, which also checks that they fit", async () => {
    const env = await setup();
    const a = await accept(env, "Rename Save to Save changes, and add a dark-mode toggle.", {
      kind: "accept", acknowledgement: "On it: both.",
      tickets: [
        { title: "Rename Save", name: "rename save", type: "code", scope: "rename the Save button" },
        { title: "Dark toggle", name: "dark toggle", type: "code", scope: "add the toggle" },
        { title: "Label", name: "label", type: "code", scope: "fix a label", check: "none" },
      ],
    });
    assert.deepEqual(tickets(a), ["dark-toggle", "label", "rename-save", "rename-save-spec"]);
    const s = env.state();
    assert.deepEqual(s.checks[s.tickets["rename-save"].check].members, ["rename-save", "dark-toggle"]);
    assert.equal(s.tickets.label.check, undefined, "check none: no proof");
    await env.report("rename-save", 1, READY);
    await env.report("rename-save-spec", 1, READY);
    const r = await env.report("dark-toggle", 1, READY);
    assert.deepEqual(tickets(r), ["rename-save-proof"]);
    assert.match(env.brief("rename-save-proof", 1), /- rename-save \(code\)[\s\S]*- dark-toggle \(code\)/);
  });

  it("proof only: no test worker, the proof starts once the work is ready", async () => {
    const env = await setup();
    const a = await accept(env, "write tests for the parser", one("parser tests", "test"));
    assert.deepEqual(tickets(a), ["parser-tests"]);
    const r = await env.report("parser-tests", 1, READY);
    assert.deepEqual(tickets(r), ["parser-tests-proof"]);
    assert.match(env.brief("parser-tests-proof", 1), /No acceptance tests were written/);
  });

  it("without worktrees a passed proof ends the work and the person hears the result at once", async () => {
    const env = await setup({ isolation: "serial" });
    await accept(env, "fix the crash", one("fix crash", "debug", { check: "proof" }));
    await env.report("fix-crash", 1, "state: ready\nsummary: Fixed.\nhuman_action: none\n---\nok");
    const r = await env.report("fix-crash-proof", 1, proofSays("pass"));
    assert.equal(r.handoff.kind, "result");
    assert.equal(env.state().tickets["fix-crash"].ended.outcome, "completed");
  });

  it("proofRounds 0 turns checks off; docs are unchecked by default", async () => {
    const off = await setup({ proofRounds: 0 });
    assert.deepEqual(tickets(await accept(off, "fix it", one("fix"))), ["fix"]);
    assert.equal(off.state().checks, undefined);
    const env = await setup();
    assert.deepEqual(tickets(await accept(env, "update the README", one("readme", "docs"))), ["readme"]);
    const bad = await accept(env, "x", one("x", "code", { check: "maybe" }));
    assert.equal(bad.results[0].ok, false);
    assert.match(bad.results[0].error, /check must be one of full, proof, none/);
  });

  it("a stopped ticket leaves nothing to prove: its test worker stops too", async () => {
    const env = await setup();
    await accept(env, "Add a dark-mode toggle.", one("dark toggle"));
    const stop = await env.call("intake", { text: "stop the toggle" });
    const r = await env.call("route", { decisions: [{ kind: "stop", trigger_id: stop.trigger_id, ticket_id: "dark-toggle" }] });
    assert.ok(r.stopAgents.includes("dark-toggle-spec#1"));
    const s = env.state();
    assert.equal(s.tickets["dark-toggle-spec"].ended.outcome, "dropped");
    assert.equal(s.checks[s.tickets["dark-toggle"].check].state, "closed");
  });

  it("a worker that splits its ticket hands its place in the group to the parts", async () => {
    const env = await setup();
    await accept(env, "drop AI cost throughout the project", one("ai cost"));
    const r = await env.report("ai-cost", 1, "state: dropped\nsummary: split\nhuman_action: none\nsplit: api (code): the API; web (code): the web app\n---\n");
    assert.deepEqual(r.split, ["ai-cost-api", "ai-cost-web"]);
    const s = env.state();
    const g = s.checks[s.tickets["ai-cost-api"].check];
    assert.deepEqual(g.members, ["ai-cost-api", "ai-cost-web"]);
    assert.equal(g.spec, "ai-cost-spec", "the acceptance tests of the whole request go on");
  });
});
