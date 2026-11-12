"use strict";

// The domain, end to end through the tools: intake → gate → Eval → Decision → Ticket → turns →
// report → handoff, follow-ups, handback, release, stop, retry, policy changes, pause, recovery.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadMain, sandbox, fakePi, put, get, withHome } = require("./helpers.js");

const MODELS = [
  { key: "anthropic/claude-opus-5-5", providerId: "anthropic", providerName: "Anthropic", modelId: "claude-opus-5-5", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
  { key: "anthropic/claude-sonnet-5-5", providerId: "anthropic", providerName: "Anthropic", modelId: "claude-sonnet-5-5", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
  { key: "google/gemini-3.8-flash", providerId: "google", providerName: "Google", modelId: "gemini-3.8-flash", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
  { key: "openai/gpt-5", providerId: "openai", providerName: "OpenAI", modelId: "gpt-5", availableForSubagents: false, supportsReasoning: true, thinkingLevels: ["low", "high"] },
];

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

async function setup(settings = {}, models = MODELS) {
  const dirs = sandbox();
  const restore = withHome(dirs.home);
  cleanups.push(() => {
    restore();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
  // the lifecycle tests run writers in the shared checkout; worktree isolation has its own tests
  const pi = fakePi(dirs, { settings: { isolation: "serial", ...settings }, models });
  const main = loadMain(pi);
  await main.onLoad();
  await pi.call("superagent", {});
  const call = (name, args) => pi.call(`superagent_${name}`, args);
  const report = (ticket, n, text) => put(dirs, `.superagent/tickets/${ticket}/report-${n}.md`, text);
  const state = () => JSON.parse(get(dirs, ".superagent/state.json"));
  return { dirs, pi, t: main.__t, call, report, state };
}

const READY = "state: ready\nsummary: Timeout fixed.\nhuman_action: none\n---\nChanged auth.ts; npm test passed.";
const ACCEPT = { kind: "accept", title: "Fix the login timeout", name: "login timeout", type: "debug", acknowledgement: "On it: fixing the login timeout in auth.ts." };

async function accepted(env, text = "Fix the login timeout in auth.ts") {
  const intake = await env.call("intake", { text });
  const route = await env.call("route", { decisions: [{ ...ACCEPT, trigger_id: intake.trigger_id }] });
  return { intake, route, r: route.results[0] };
}

describe("intake, gate and Eval", () => {
  it("an addressed message from the person is an explicit candidate", async () => {
    const env = await setup();
    const out = await env.call("intake", { text: "Fix the login timeout" });
    assert.equal(out.path, "eval");
    assert.equal(out.candidates[0].strength, "explicit");
    assert.equal(out.candidates[0].via, "addressed");
    assert.equal(out.candidates[0].batch[0].text, "Fix the login timeout");
  });

  it("an unaddressed message is an inferred candidate carrying the enabled rules and the mode", async () => {
    const env = await setup();
    const out = await env.call("intake", { text: "the Save button label is odd", addressed: false });
    const card = out.candidates[0];
    assert.equal(card.strength, "inferred");
    assert.equal(card.mode, "observe");
    assert.deepEqual(card.rules.map((r) => r.id), ["copy", "visual"]);
  });

  it("mode off does not admit inferred candidates; an empty allowed list admits nothing", async () => {
    const env = await setup({ policy: { mode: "off" } });
    const out = await env.call("intake", { text: "hmm", addressed: false });
    assert.match(out.path, /not admitted \(no_mention\)/);
    const env2 = await setup({ policy: { sources: { chat: { allowed: [] } } } });
    const out2 = await env2.call("intake", { text: "do it" });
    assert.match(out2.path, /not admitted \(not_a_member\)/);
  });

  it("a candidate expires, is queued again twice, then records unavailable", async () => {
    const env = await setup({ evalTimeoutSeconds: 30 });
    const { trigger_id } = await env.call("intake", { text: "do something" });
    const s = env.state();
    const thread = Object.values(s.threads)[0];
    for (let i = 0; i < 3; i++) {
      const cur = env.state();
      Object.values(cur.threads)[0].evaluating.deadline = "2000-01-01T00:00:00.000Z";
      put(env.dirs, ".superagent/state.json", JSON.stringify(cur));
      await env.call("ticket", { action: "list" });
    }
    const end = env.state();
    assert.equal(end.decisions.at(-1).kind, "unavailable");
    assert.equal(end.dispositions[trigger_id].decisionId, end.decisions.at(-1).id);
    const l = await env.call("ticket", { action: "list" });
    assert.match(l.unavailable[0], new RegExp(thread.key));
  });
});

describe("accept, launch, report, reply", () => {
  it("accept creates a ticket with a mandate, routes its model, posts the acknowledgement and launches turn 1", async () => {
    const env = await setup();
    const { r, route } = await accepted(env);
    assert.equal(r.ok, true);
    assert.equal(r.ticket, "login-timeout");
    assert.equal(r.agent, "worker-code");
    assert.ok(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "google/gemini-3.8-flash"].includes(r.model), "only models enabled for sub-agents");
    assert.equal(r.post, ACCEPT.acknowledgement);
    assert.equal(route.launch.length, 1);
    assert.equal(route.launch[0].turn, 1);
    const t = env.state().tickets["login-timeout"];
    assert.equal(t.mandate.strength, "explicit");
    assert.equal(t.mandate.basis.via, "addressed");
    const brief = get(env.dirs, ".superagent/tickets/login-timeout/turn-1.md");
    assert.match(brief, /> Fix the login timeout in auth\.ts/);
    assert.match(brief, /## Ticket scope/);
    assert.match(brief, /state: progress \| waiting \| ready \| blocked \| failed \| dropped/);
  });

  it("accept needs an acknowledgement and refuses a long routing note; items fail independently", async () => {
    const env = await setup();
    const a = await env.call("intake", { text: "one" });
    const b = await env.call("intake", { text: "two" });
    const c = await env.call("intake", { text: "three" });
    const out = await env.call("route", {
      decisions: [
        { ...ACCEPT, trigger_id: a.trigger_id, acknowledgement: "" },
        { ...ACCEPT, trigger_id: b.trigger_id, note: "word ".repeat(31) },
        { ...ACCEPT, trigger_id: c.trigger_id, acknowledgement: "I'll handle it." },
      ],
    });
    assert.match(out.results[0].error, /acknowledgement is required/);
    assert.match(out.results[1].error, /31 words/);
    assert.match(out.results[2].error, /acknowledgement is generic/);
  });

  it("a ready report ends the ticket and the result is cleared once", async () => {
    const env = await setup();
    await accepted(env);
    env.report("login-timeout", 1, READY);
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    assert.equal(r.stage, "ended/completed");
    assert.equal(r.handoff.kind, "result");
    const reply = await env.call("reply", { purpose: "result", ticket_id: "login-timeout", text: "The login timeout is fixed." });
    assert.equal(reply.post, "The login timeout is fixed.");
    const again = await env.call("reply", { purpose: "result", ticket_id: "login-timeout", text: "The login timeout is fixed." });
    assert.equal(again.reused, true);
  });

  it("replies are purpose-checked: no result before ready, attention must copy the open question", async () => {
    const env = await setup();
    await accepted(env);
    await assert.rejects(env.call("reply", { purpose: "result", ticket_id: "login-timeout", text: "done" }), /ready, completed or dropped/);
    env.report("login-timeout", 1, "state: waiting\nsummary: Two options.\nhuman_action: 30s or 60s?\n---\n");
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    assert.equal(r.stage, "person/answer");
    assert.equal(r.handoff.question, "30s or 60s?");
    await assert.rejects(env.call("reply", { purpose: "attention", ticket_id: "login-timeout", question: "30 or 60?", text: "x" }), /copied exactly/);
    const ok = await env.call("reply", { purpose: "attention", ticket_id: "login-timeout", question: "30s or 60s?", text: "Should the timeout be 30s or 60s?" });
    assert.ok(ok.post);
    await assert.rejects(env.call("reply", { purpose: "result", ticket_id: "login-timeout", text: "w ".repeat(101) }), /101 words/);
  });
});

describe("follow-ups, subscriptions, handback and release", () => {
  it("a reply on the ticket's thread goes to its worker, takes no Eval, and resumes an ended ticket on the same model", async () => {
    const env = await setup();
    const { intake, r } = await accepted(env);
    env.report("login-timeout", 1, READY);
    await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    const f = await env.call("intake", { text: "Also on the signup page please", thread: intake.thread });
    assert.equal(f.path, "follow-up");
    assert.deepEqual(f.followUps[0].delivered_to, ["login-timeout"]);
    assert.equal(f.launch[0].turn, 2);
    assert.equal(f.launch[0].model, r.model);
    assert.match(get(env.dirs, ".superagent/tickets/login-timeout/turn-2.md"), /\[NEW\] message m\d+ on thread chat:\d+[\s\S]*> Also on the signup page please/);
    assert.equal(env.state().tickets["login-timeout"].ended, undefined);
  });

  it("only stop is allowed on an owned follow-up", async () => {
    const env = await setup();
    const { intake } = await accepted(env);
    const f = await env.call("intake", { text: "actually stop this", thread: intake.thread });
    const bad = await env.call("route", { decisions: [{ kind: "ignore", trigger_id: f.trigger_id, reason: "x" }] });
    assert.match(bad.results[0].error, /workers decide it/);
    const stop = await env.call("route", { decisions: [{ kind: "stop", trigger_id: f.trigger_id, ticket_id: "login-timeout" }] });
    assert.equal(stop.results[0].stage, "ended/stopped");
    assert.deepEqual(stop.stopAgents, ["login-timeout#1"]);
    const after = await env.call("intake", { text: "go on", thread: intake.thread });
    assert.equal(after.path, "eval", "a stopped ticket receives nothing; the message goes to Eval");
    const attach = await env.call("route", { decisions: [{ kind: "attach", trigger_id: after.trigger_id, ticket_id: "login-timeout" }] });
    assert.match(attach.results[0].error, /a person stopped/);
  });

  it("a handed-back follow-up goes to Eval with the reason, and cannot be attached back", async () => {
    const env = await setup();
    const { intake } = await accepted(env);
    env.report("login-timeout", 1, "state: waiting\nsummary: Need input.\nhuman_action: Which env?\n---\n");
    await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    const f = await env.call("intake", { text: "staging. Also rewrite the README", thread: intake.thread });
    env.report("login-timeout", 2, `state: ready\nsummary: Fixed on staging.\nhuman_action: none\nacked: ${f.trigger_id}\nhandback: ${f.trigger_id}: the README rewrite is separate work\n---\n`);
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 2 });
    assert.equal(r.handbacks[0].id, f.trigger_id);
    const card = r.candidates.find((c) => c.trigger_id === f.trigger_id);
    assert.equal(card.handed_back[0].reason, "the README rewrite is separate work");
    const back = await env.call("route", { decisions: [{ kind: "attach", trigger_id: f.trigger_id, ticket_id: "login-timeout" }] });
    assert.match(back.results[0].error, /handed this message back/);
  });

  it("a message sent while a turn ran is read in a recheck turn before the ticket ends", async () => {
    const env = await setup();
    const { intake } = await accepted(env);
    const f = await env.call("intake", { text: "FYI it only happens on Safari", thread: intake.thread });
    assert.equal(f.path, "follow-up");
    env.report("login-timeout", 1, READY);
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    assert.equal(r.stage, "working");
    assert.equal(r.handoff.kind, "none", "no result is announced before the worker read the message");
    assert.match(r.note, /held/);
    assert.equal(r.candidates, undefined);
    await assert.rejects(env.call("reply", { purpose: "result", ticket_id: "login-timeout", text: "done" }), /ready, completed or dropped/);
    assert.match(get(env.dirs, ".superagent/tickets/login-timeout/turn-2.md"), /\*\*Recheck\.\*\*[\s\S]*\[NEW\][\s\S]*Safari/);
    env.report("login-timeout", 2, `state: ready\nsummary: Fixed, Safari included.\nhuman_action: none\nacked: ${f.trigger_id}\n---\n`);
    const r2 = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 2 });
    assert.equal(r2.stage, "ended/completed");
    assert.equal(r2.handoff.kind, "result");
  });

  it("messages the worker never read are released to Eval when a person stops the ticket", async () => {
    const env = await setup();
    const { intake } = await accepted(env);
    const other = await env.call("intake", { text: "and the logout too", thread: intake.thread });
    const stopMsg = await env.call("intake", { text: "stop the login work", thread: intake.thread });
    const st = await env.call("route", { decisions: [{ kind: "stop", trigger_id: stopMsg.trigger_id, ticket_id: "login-timeout" }] });
    assert.deepEqual(st.candidates.map((c) => c.trigger_id), [other.trigger_id]);
  });

  it("an unrelated attached thread is dropped and its messages handed back", async () => {
    const env = await setup();
    await accepted(env);
    const other = await env.call("intake", { text: "the login-timeout fix broke CSS" });
    const att = await env.call("route", { decisions: [{ kind: "attach", trigger_id: other.trigger_id, ticket_id: "login-timeout" }] });
    assert.equal(att.results[0].ok, true);
    env.report("login-timeout", 1, `state: waiting\nsummary: x\nhuman_action: none\nunrelated: ${other.thread}: it is about CSS, not the timeout\n---\n`);
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    assert.ok((r.candidates || []).some((c) => c.trigger_id === other.trigger_id));
    assert.ok(!env.state().threads[other.thread].subscriptions.includes("login-timeout"));
  });
});

describe("worker slots, failures, retry and recovery", () => {
  it("turns beyond maxWorkers queue; only a person's message may use the one extra slot", async () => {
    const env = await setup({ maxWorkers: 1, isolation: "worktree" });
    const a = await accepted(env, "first");
    env.report("login-timeout", 1, "state: waiting\nsummary: idle\nhuman_action: none\n---\n");
    await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    const ib = await env.call("intake", { text: "second" });
    const b = await env.call("route", { decisions: [{ ...ACCEPT, name: "second", trigger_id: ib.trigger_id }] });
    assert.equal(b.launch[0].ticket, "second");
    const ic = await env.call("intake", { text: "third" });
    const c = await env.call("route", { decisions: [{ ...ACCEPT, name: "third", trigger_id: ic.trigger_id }] });
    assert.equal(c.launch, undefined, "a new launch waits for a normal slot");
    assert.deepEqual(c.queued, ["third#1"]);
    const f = await env.call("intake", { text: "one more thing on the first", thread: a.intake.thread });
    assert.equal(f.launch[0].ticket, "login-timeout", "a person's message takes the extra slot");
    env.report("second", 1, READY);
    const r = await env.call("ticket", { action: "report", ticket: "second", turn: 1 });
    assert.equal(r.launch[0].ticket, "third");
  });

  it("a limit fails over to the next model with a recovery note; other passing failures retry, then fail", async () => {
    const env = await setup({ excludeThinking: [] });
    const { r } = await accepted(env);
    const lim = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1, outcome: "error", error: "429 rate limit reached" });
    assert.match(lim.note, /failed over/);
    assert.notEqual(lim.launch[0].model.split("/")[0], r.model.split("/")[0], "a limit fails over to another provider first");
    assert.equal(lim.launch[0].thinking, "high", "the thinking level is the failover model's, not the first model's");
    assert.match(get(env.dirs, ".superagent/tickets/login-timeout/turn-2.md"), /## Recovery note[\s\S]*hit a limit/);
    const n = lim.launch[0].turn;
    for (let i = 1; i < 3; i++) {
      const x = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: n, outcome: "error", error: "socket timeout" });
      assert.equal(x.launch[0].turn, n);
    }
    const f = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: n, outcome: "error", error: "socket timeout" });
    assert.equal(f.stage, "person/failed");
    const retry = await env.call("ticket", { action: "retry", ticket: "login-timeout" });
    assert.equal(retry.stage, "working");
    assert.equal(retry.launch.length, 1);
  });

  it("a written report counts even when the sub-agent errored afterwards", async () => {
    const env = await setup();
    await accepted(env);
    env.report("login-timeout", 1, READY);
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1, outcome: "error", error: "timeout" });
    assert.equal(r.stage, "ended/completed");
  });

  it("progress at the end of a turn gets go-on turns, then idles", async () => {
    const env = await setup();
    await accepted(env);
    for (const n of [1, 2]) {
      env.report("login-timeout", n, "state: progress\nsummary: halfway\n---\n");
      const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: n });
      assert.equal(r.launch[0].turn, n + 1);
    }
    assert.match(get(env.dirs, ".superagent/tickets/login-timeout/turn-3.md"), /\*\*Go on\.\*\*/);
    env.report("login-timeout", 3, "state: progress\nsummary: still going\n---\n");
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 3 });
    assert.equal(r.stage, "idle");
    const st = await env.call("ticket", { action: "status", ticket: "login-timeout" });
    assert.match(get(env.dirs, `.superagent/tickets/login-timeout/turn-${st.launch[0].turn}.md`), /status turn/);
  });

  it("a turn cut off by a restart starts a new assignment with a recovery note", async () => {
    const env = await setup();
    await accepted(env);
    const s = env.state();
    s.tickets["login-timeout"].assignments[0].turns[0].startedAt = "2000-01-01T00:00:00.000Z";
    put(env.dirs, ".superagent/state.json", JSON.stringify(s));
    const l = await env.call("ticket", { action: "list" });
    assert.match(l.warnings[0], /cut off/);
    assert.equal(l.launch[0].turn, 2);
    assert.match(get(env.dirs, ".superagent/tickets/login-timeout/turn-2.md"), /host restarted/);
  });
});

describe("policy", () => {
  it("observe records would_accept; auto accepts an inferred candidate under the matched rule", async () => {
    const env = await setup();
    const i = await env.call("intake", { text: "typo: 'Recieve' should be 'Receive' on the login page", addressed: false });
    const assess = {
      trigger_id: i.trigger_id, decision: "accept",
      rule_assessments: [{ rule_id: "copy", matched: true, reason: "a typo with the correct spelling" }, { rule_id: "visual", matched: false, reason: "no visual change" }],
      direction: { implementation_requested: true, target_basis: "specified", requires_design_decision: false, evidence: "'should be Receive'" },
      intent_evidence: "this project's login page; a fix is wanted; the right spelling is given", title: "Fix typo", name: "typo", type: "docs",
    };
    const obs = await env.call("eval_decide", assess);
    assert.equal(obs.would_accept, true);
    await env.call("config", { action: "set", mode: "auto" });
    const i2 = await env.call("intake", { text: "typo: 'Recieve' should be 'Receive' in the footer", addressed: false });
    const acc = await env.call("eval_decide", { ...assess, trigger_id: i2.trigger_id, name: "typo footer" });
    assert.equal(acc.kind, "accept");
    const t = env.state().tickets[acc.ticket];
    assert.equal(t.mandate.strength, "inferred");
    assert.deepEqual(t.mandate.basis.rules, ["copy"]);
    assert.match(get(env.dirs, `.superagent/tickets/${acc.ticket}/turn-1.md`), /accepted proactively under these rules[\s\S]*Copy fixes \(copy\)/);
  });

  it("an assessment must judge every enabled rule once and settle the direction", async () => {
    const env = await setup({ policy: { mode: "auto" } });
    const i = await env.call("intake", { text: "spacing looks off", addressed: false });
    await assert.rejects(env.call("eval_decide", { trigger_id: i.trigger_id, decision: "ignore", rule_assessments: [{ rule_id: "copy", matched: false, reason: "x" }], direction: { implementation_requested: false, target_basis: "undetermined", requires_design_decision: true, evidence: "x" } }), /every enabled rule exactly once/);
    const r = await env.call("eval_decide", {
      trigger_id: i.trigger_id, decision: "accept", intent_evidence: "x", title: "x", name: "x", type: "code",
      rule_assessments: [{ rule_id: "copy", matched: false, reason: "no copy" }, { rule_id: "visual", matched: true, reason: "spacing" }],
      direction: { implementation_requested: true, target_basis: "undetermined", requires_design_decision: true, evidence: "no target given" },
    });
    assert.equal(r.kind, "ignore");
    assert.match(r.why, /direction unsettled/);
  });

  it("a policy change sends a policy-changed input to affected tickets, and a revoked mandate does not resume", async () => {
    const env = await setup({ policy: { mode: "auto" } });
    const i = await env.call("intake", { text: "typo Recieve", addressed: false });
    const acc = await env.call("eval_decide", {
      trigger_id: i.trigger_id, decision: "accept", intent_evidence: "x", title: "typo", name: "typo", type: "docs",
      rule_assessments: [{ rule_id: "copy", matched: true, reason: "typo" }, { rule_id: "visual", matched: false, reason: "no" }],
      direction: { implementation_requested: true, target_basis: "specified", requires_design_decision: false, evidence: "x" },
    });
    env.report("typo", 1, "state: waiting\nsummary: x\nhuman_action: none\n---\n");
    await env.call("ticket", { action: "report", ticket: acc.ticket, turn: 1 });
    const changed = await env.call("config", { action: "set", mode: "observe" });
    const t = env.state().tickets.typo;
    const pc = t.inputs.find((x) => x.kind === "policy-changed");
    assert.equal(pc.effect.proactive, false);
    assert.ok(changed.launch.some((l) => l.ticket === "typo"));
    env.report("typo", 2, "state: ready\nsummary: done\nhuman_action: none\n---\n");
    await env.call("ticket", { action: "report", ticket: "typo", turn: 2 });
    const f = await env.call("intake", { text: "one more typo", thread: i.thread });
    assert.equal(f.path, "eval", "a revoked mandate does not resume; the message is assessed as reaching no ticket");
  });

  it("pause records messages but holds Evals, launches and replies until resumed", async () => {
    const env = await setup();
    await env.call("config", { action: "set", paused: true });
    const i = await env.call("intake", { text: "fix it" });
    assert.equal(i.path, "recorded while paused");
    assert.equal(i.candidates, undefined);
    const resumed = await env.call("config", { action: "set", paused: false });
    assert.equal(resumed.candidates[0].trigger_id, i.trigger_id);
  });
});

describe("report parsing and helpers", () => {
  it("parses headers, fences, bold keys, lists and pairs", async () => {
    const { t } = await setup();
    const r = t.parseReport("---\n**state:** ready\n- summary: ok\nhuman_action: None.\nacked: m1, m2\nhandback: m3: separate work; m4: another ticket\nunrelated: chat:7: about CSS\n---\nbody");
    assert.equal(r.state, "ready");
    assert.equal(r.human_action, null);
    assert.deepEqual(r.acked, ["m1", "m2"]);
    assert.deepEqual(r.handback, [{ id: "m3", reason: "separate work" }, { id: "m4", reason: "another ticket" }]);
    assert.deepEqual(r.unrelated, [{ id: "chat:7", reason: "about CSS" }]);
    assert.equal(r.body, "body");
    assert.equal(t.parseReport("state: ready\n").human_action, undefined);
    assert.equal(t.parseReport("nothing").state, null);
  });

  it("counts CJK characters as words", async () => {
    const { t } = await setup();
    assert.equal(t.wordCount("修复登录 bug"), 5);
  });
});

describe("review regressions", () => {
  it("a stop's own message is not released to Eval", async () => {
    const env = await setup();
    const { intake } = await accepted(env);
    const f = await env.call("intake", { text: "stop this please", thread: intake.thread });
    const stop = await env.call("route", { decisions: [{ kind: "stop", trigger_id: f.trigger_id, ticket_id: "login-timeout" }] });
    assert.equal(stop.candidates, undefined);
    assert.ok(!env.state().threads[intake.thread].evaluating);
  });

  it("stopping a ticket that ended on its own records stopUnknown and keeps its outcome", async () => {
    const env = await setup();
    await accepted(env);
    env.report("login-timeout", 1, READY);
    await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    const i = await env.call("intake", { text: "stop the login ticket" });
    const r = await env.call("route", { decisions: [{ kind: "stop", trigger_id: i.trigger_id, ticket_id: "login-timeout" }] });
    assert.equal(r.results[0].stage, "ended/completed");
    assert.equal(env.state().decisions.at(-1).reason[0].code, "stopUnknown");
  });

  it("a message sent while a turn ran lifts the blocked hold and is delivered", async () => {
    const env = await setup();
    const { intake } = await accepted(env);
    await env.call("intake", { text: "the logs are in /tmp/x", thread: intake.thread });
    env.report("login-timeout", 1, "state: blocked\nsummary: No logs.\nhuman_action: none\n---\n");
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    assert.equal(r.stage, "working");
    assert.equal(r.launch[0].turn, 2);
  });

  it("returns a worker's answer to the person's question", async () => {
    const env = await setup();
    const { intake } = await accepted(env);
    const q = await env.call("intake", { text: "why does it time out?", thread: intake.thread });
    env.report("login-timeout", 1, `state: waiting\nsummary: The token refresh blocks the login.\nhuman_action: none\nreply_to_trigger_id: ${q.trigger_id}\n---\n`);
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    assert.deepEqual(r.answer, { trigger_id: q.trigger_id, summary: "The token refresh blocks the login." });
    const reply = await env.call("reply", { purpose: "answer", ticket_id: "login-timeout", trigger_id: q.trigger_id, text: "The token refresh blocks the login." });
    assert.ok(reply.post);
  });

  it("a status turn ending in progress schedules no work", async () => {
    const env = await setup();
    await accepted(env);
    env.report("login-timeout", 1, "state: waiting\nsummary: idle\nhuman_action: none\n---\n");
    await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    const st = await env.call("ticket", { action: "status", ticket: "login-timeout" });
    env.report("login-timeout", st.launch[0].turn, "state: progress\nsummary: halfway\n---\n");
    const r = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: st.launch[0].turn });
    assert.equal(r.launch, undefined);
    assert.equal(r.stage, "idle");
  });

  it("a relaunch is reported once: a stale attempt is ignored", async () => {
    const env = await setup();
    await accepted(env);
    const x = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1, attempt: 1, outcome: "error", error: "socket hang up" });
    assert.equal(x.launch[0].attempt, 2);
    const dup = await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1, attempt: 1, outcome: "error", error: "socket hang up" });
    assert.match(dup.note, /already handled/);
    assert.equal(dup.launch, undefined);
  });

  it("recover restarts a turn lost to a restart, with a recovery note", async () => {
    const env = await setup();
    await accepted(env);
    const r = await env.call("ticket", { action: "recover", ticket: "login-timeout" });
    assert.equal(r.launch[0].turn, 2);
    assert.match(get(env.dirs, ".superagent/tickets/login-timeout/turn-2.md"), /was lost/);
  });

  it("an unlisted sender's direct follow-up is not admitted as a follow-up", async () => {
    const env = await setup();
    const { intake } = await accepted(env);
    env.report("login-timeout", 1, READY);
    await env.call("ticket", { action: "report", ticket: "login-timeout", turn: 1 });
    await env.call("config", { action: "set", allowed: ["someone-else"] });
    const f = await env.call("intake", { text: "more", thread: intake.thread });
    // the ended ticket's mandate no longer holds, so the message reaches no ticket; the gate refuses an unlisted sender
    assert.equal(f.path, "not admitted (not_a_member)");
    assert.equal(f.followUps, undefined);
  });

  it("a policy change records unavailable for a running Eval and queues it again", async () => {
    const env = await setup();
    const i = await env.call("intake", { text: "fix it" });
    const out = await env.call("config", { action: "set", mode: "auto" });
    assert.equal(env.state().decisions.at(-1).kind, "unavailable");
    assert.equal(out.candidates[0].trigger_id, i.trigger_id);
  });
});
