"use strict";

// Several tickets from one message, and workers that change files kept apart: git worktrees, one
// writer at a time without git, and merge tickets that land the ready branches.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadMain, sandbox, fakePi, put, get, withHome } = require("./helpers.js");

const MODELS = [
  { key: "anthropic/claude-opus-5-5", providerId: "anthropic", providerName: "Anthropic", modelId: "claude-opus-5-5", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
  { key: "google/gemini-3.8-flash", providerId: "google", providerName: "Google", modelId: "gemini-3.8-flash", availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
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
  const pi = fakePi(dirs, { settings, models: MODELS });
  const main = loadMain(pi);
  await main.onLoad();
  const call = (name, args) => pi.call(`superagent_${name}`, args);
  const report = (ticket, n, text) => put(dirs, `.superagent/tickets/${ticket}/report-${n}.md`, text);
  const state = () => JSON.parse(get(dirs, ".superagent/state.json"));
  const brief = (ticket, n) => get(dirs, `.superagent/tickets/${ticket}/turn-${n}.md`);
  return { dirs, call, report, state, brief };
}

const ready = (extra = "isolation: worktree\nmerge: yes") => `state: ready\nsummary: Done.\nhuman_action: none\n${extra}\n---\nCommitted on the branch; tests passed.`;
const one = (name, type = "code") => ({ kind: "accept", title: name, name, type, acknowledgement: `On it: ${name}.` });

async function accept(env, text, decision) {
  const intake = await env.call("intake", { text });
  const out = await env.call("route", { decisions: [{ ...decision, trigger_id: intake.trigger_id }] });
  return { intake, out, r: out.results[0] };
}

const SPLIT = {
  kind: "accept", acknowledgement: "On it: renaming the Save button and adding a dark-mode toggle.",
  tickets: [
    { title: "Rename Save button", name: "rename save", type: "code", scope: "rename the Save button to Save changes" },
    { title: "Dark-mode toggle", name: "dark toggle", type: "code", scope: "add a dark-mode toggle to the settings page" },
  ],
};

describe("several tickets from one message", () => {
  it("one accept starts one ticket per request, with one acknowledgement and one decision", async () => {
    const env = await setup({ isolation: "worktree" });
    const { r, out } = await accept(env, "Rename the Save button to 'Save changes', and add a dark-mode toggle.", SPLIT);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.tickets.map((x) => x.ticket), ["rename-save", "dark-toggle"]);
    assert.equal(r.post, SPLIT.acknowledgement);
    assert.deepEqual(out.launch.map((x) => x.ticket).sort(), ["dark-toggle", "rename-save"], "both run in parallel");
    const s = env.state();
    assert.deepEqual(s.tickets["rename-save"].siblings, ["dark-toggle"]);
    assert.equal(s.tickets["dark-toggle"].mandate.scope, "add a dark-mode toggle to the settings page");
    const d = s.decisions.at(-1);
    assert.equal(d.kind, "accept");
    assert.deepEqual(d.ticketIds, ["rename-save", "dark-toggle"]);
    const b = env.brief("rename-save", 1);
    assert.match(b, /## Split request/);
    assert.match(b, /- dark-toggle \(code\): add a dark-mode toggle/);
    assert.match(b, /> Rename the Save button/, "each worker reads the whole message");
  });

  it("refuses a split without a scope and leaves no half-made tickets", async () => {
    const env = await setup();
    const bad = { ...SPLIT, tickets: [SPLIT.tickets[0], { ...SPLIT.tickets[1], scope: "" }] };
    const { r, intake } = await accept(env, "two things", bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /tickets\[1\]: scope is required/);
    assert.deepEqual(Object.keys(env.state().tickets), []);
    const again = await env.call("route", { decisions: [{ ...SPLIT, trigger_id: intake.trigger_id }] });
    assert.equal(again.results[0].ok, true, "the candidate still waits for a decision");
  });

  it("a follow-up on the thread reaches every ticket of the message", async () => {
    const env = await setup({ isolation: "worktree" });
    const { intake } = await accept(env, "two things", SPLIT);
    const f = await env.call("intake", { text: "use the word Save, not Store", thread: intake.thread });
    assert.equal(f.path, "follow-up");
    assert.deepEqual(f.followUps[0].delivered_to.sort(), ["dark-toggle", "rename-save"]);
  });
});

describe("workers that change files", () => {
  it("each gets its own worktree, branch and base ref in its brief and launch item", async () => {
    const env = await setup({ isolation: "worktree" });
    const { out } = await accept(env, "fix it", one("fix it"));
    assert.equal(out.launch[0].worktree, ".superagent/worktrees/fix-it");
    const b = env.brief("fix-it", 1);
    assert.match(b, /## Workspace isolation/);
    assert.match(b, /git worktree add -b superagent\/fix-it \.superagent\/worktrees\/fix-it refs\/superagent\/base\/fix-it/);
    assert.match(b, /git stash create/);
    assert.match(b, /^isolation: </m);
    assert.match(b, /^merge: </m);
  });

  it("auto: writers run one at a time until a worker confirms git, then in parallel", async () => {
    const env = await setup();
    const a = await accept(env, "first", one("first"));
    assert.equal(a.out.launch[0].ticket, "first");
    const b = await accept(env, "second", one("second"));
    assert.equal(b.out.launch, undefined, "the second writer waits");
    assert.deepEqual(b.out.queued, ["second#1"]);
    const research = await accept(env, "look into x", one("look", "research"));
    assert.equal(research.out.launch[0].ticket, "look", "read-only workers are not held");
    env.report("first", 1, "state: progress\nsummary: halfway\nhuman_action: none\nisolation: worktree\n---\n");
    const r = await env.call("ticket", { action: "report", ticket: "first", turn: 1 });
    assert.deepEqual(r.launch.map((x) => x.ticket).sort(), ["first", "second"], "git confirmed: both writers run");
    assert.equal(env.state().vcs, "git");
  });

  it("without git a writer works in the shared checkout and later writers run one at a time there", async () => {
    const env = await setup();
    await accept(env, "first", one("first"));
    env.report("first", 1, ready("isolation: none"));
    const r = await env.call("ticket", { action: "report", ticket: "first", turn: 1 });
    assert.equal(r.stage, "ended/completed", "nothing to merge");
    assert.equal(r.handoff.kind, "result");
    assert.equal(env.state().vcs, "none");
    const b = await accept(env, "second", one("second"));
    assert.equal(b.out.launch[0].worktree, undefined);
    assert.match(env.brief("second", 1), /## Workspace\n\nYou work in the main checkout/);
    const c = await accept(env, "third", one("third", "docs"));
    assert.equal(c.out.launch, undefined, "a second shared writer waits");
  });

  it("serial never uses worktrees", async () => {
    const env = await setup({ isolation: "serial" });
    const { out } = await accept(env, "fix", one("fix"));
    assert.equal(out.launch[0].worktree, undefined);
    assert.equal(env.state().tickets.fix.isolation.mode, "shared");
  });

  it("a ready branch with nothing to land completes without a merge", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "fix", one("fix"));
    env.report("fix", 1, ready("isolation: worktree\nmerge: no"));
    const r = await env.call("ticket", { action: "report", ticket: "fix", turn: 1 });
    assert.equal(r.stage, "ended/completed");
    assert.ok(!Object.keys(env.state().tickets).includes("merge"));
  });

  it("a read-only worker sees the branches that are not merged yet", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "fix", one("fix"));
    await accept(env, "review the fix", one("review fix", "review"));
    assert.match(env.brief("review-fix", 1), /## Ticket branches[\s\S]*- fix \[working\]: branch `superagent\/fix`/);
  });
});

describe("merge tickets", () => {
  it("a ready branch is queued, a merge ticket lands it, and the person hears one result", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "fix it", one("fix"));
    env.report("fix", 1, ready());
    const r = await env.call("ticket", { action: "report", ticket: "fix", turn: 1 });
    assert.equal(r.handoff.kind, "none", "no result before the merge");
    assert.match(r.note, /queued for the merge worker/);
    assert.equal(r.stage, "working/merge");
    assert.equal(r.launch[0].ticket, "merge");
    assert.equal(r.launch[0].agent, "superagent-worker-code");
    const s = env.state();
    assert.equal(s.tickets.merge.type, "merge");
    assert.deepEqual(s.tickets.merge.merges, ["fix"]);
    assert.deepEqual(s.tickets.fix.merge.state, "merging");
    const b = env.brief("merge", 1);
    assert.match(b, /merge worker/);
    assert.match(b, /branch: `superagent\/fix`/);
    assert.match(b, /git diff --binary <base ref> <branch> \| git apply --3way/);
    await assert.rejects(env.call("reply", { purpose: "result", ticket_id: "fix", text: "Done." }), /ready, completed or dropped/);
    env.report("merge", 1, "state: ready\nsummary: The fix is in your working tree; tests pass.\nhuman_action: none\n---\nLanded superagent/fix.");
    const m = await env.call("ticket", { action: "report", ticket: "merge", turn: 1 });
    assert.equal(m.stage, "ended/completed");
    assert.equal(m.handoff.kind, "result");
    assert.deepEqual(m.handoff.merged.map((x) => x.ticket), ["fix"]);
    assert.equal(env.state().tickets.fix.ended.outcome, "completed");
    const reply = await env.call("reply", { purpose: "result", ticket_id: "merge", text: "The fix is in your working tree." });
    assert.equal(reply.post, "The fix is in your working tree.");
  });

  it("tickets of one message are merged together, after the last of them is ready", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "two things", SPLIT);
    env.report("rename-save", 1, ready());
    const a = await env.call("ticket", { action: "report", ticket: "rename-save", turn: 1 });
    assert.equal(a.launch, undefined, "waits for its sibling");
    assert.equal(env.state().tickets.merge, undefined);
    env.report("dark-toggle", 1, ready());
    const b = await env.call("ticket", { action: "report", ticket: "dark-toggle", turn: 1 });
    assert.equal(b.launch[0].ticket, "merge");
    assert.deepEqual(env.state().tickets.merge.merges, ["rename-save", "dark-toggle"]);
  });

  it("one merge at a time", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "a", one("a"));
    await accept(env, "b", one("b"));
    env.report("a", 1, ready());
    await env.call("ticket", { action: "report", ticket: "a", turn: 1 });
    env.report("b", 1, ready());
    const r = await env.call("ticket", { action: "report", ticket: "b", turn: 1 });
    assert.equal(r.launch, undefined, "the first merge is still open");
    assert.equal(env.state().tickets.b.merge.state, "queued");
    env.report("merge", 1, "state: ready\nsummary: a landed.\nhuman_action: none\n---\n");
    const m = await env.call("ticket", { action: "report", ticket: "merge", turn: 1 });
    assert.equal(m.launch[0].ticket, "merge-2");
    assert.deepEqual(env.state().tickets["merge-2"].merges, ["b"]);
  });

  it("a merge waits while a writer works in the shared checkout", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "a", one("a"));
    await accept(env, "b", one("b"));
    env.report("b", 1, "state: progress\nsummary: halfway\nhuman_action: none\nisolation: none\n---\n");
    const p = await env.call("ticket", { action: "report", ticket: "b", turn: 1 });
    assert.equal(p.launch[0].ticket, "b", "b goes on, now in the shared checkout");
    env.report("a", 1, ready());
    const r = await env.call("ticket", { action: "report", ticket: "a", turn: 1 });
    assert.equal(r.launch, undefined, "the merge would write the same checkout as b");
    assert.deepEqual(r.queued, ["merge#1"]);
    env.report("b", 2, "state: waiting\nsummary: needs a name\nhuman_action: Which name?\nisolation: none\n---\n");
    const w = await env.call("ticket", { action: "report", ticket: "b", turn: 2 });
    assert.equal(w.launch[0].ticket, "merge");
  });

  it("a person's message on a queued branch takes it out of the queue; on a merging one it waits for the merge", async () => {
    const env = await setup({ isolation: "worktree" });
    const { intake } = await accept(env, "fix", one("fix"));
    env.report("fix", 1, ready());
    await env.call("ticket", { action: "report", ticket: "fix", turn: 1 });
    const f = await env.call("intake", { text: "also cover the edge case", thread: intake.thread });
    assert.equal(f.launch, undefined, "the branch is being merged: the new turn waits");
    env.report("merge", 1, "state: ready\nsummary: landed.\nhuman_action: none\n---\n");
    const m = await env.call("ticket", { action: "report", ticket: "merge", turn: 1 });
    assert.equal(m.launch[0].ticket, "fix", "after the merge the worker reads the message");
    assert.equal(env.state().tickets.fix.ended, undefined);
  });

  it("a stopped merge leaves its branches unmerged; merge queues them again", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "fix", one("fix"));
    env.report("fix", 1, ready());
    await env.call("ticket", { action: "report", ticket: "fix", turn: 1 });
    const stop = await env.call("intake", { text: "stop the merge" });
    await env.call("route", { decisions: [{ kind: "stop", trigger_id: stop.trigger_id, ticket_id: "merge" }] });
    const s = env.state();
    assert.equal(s.tickets.fix.merge.state, "unmerged");
    const l = await env.call("ticket", { action: "list" });
    assert.match(l.needsPerson.join("\n"), /fix \[person\/review\].*branch superagent\/fix not merged/);
    const again = await env.call("ticket", { action: "merge" });
    assert.deepEqual(again.queued, ["fix"]);
    assert.equal(again.launch[0].ticket, "merge-2");
  });

  it("a blocked merge asks on its own thread and holds later merges", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "fix", one("fix"));
    env.report("fix", 1, ready());
    await env.call("ticket", { action: "report", ticket: "fix", turn: 1 });
    env.report("merge", 1, "state: waiting\nsummary: conflict in theme.css\nhuman_action: Keep the old or the new colour?\n---\n");
    const m = await env.call("ticket", { action: "report", ticket: "merge", turn: 1 });
    assert.equal(m.handoff.kind, "question");
    const thread = env.state().tickets.merge.channels[0];
    const f = await env.call("intake", { text: "the new one", thread });
    assert.deepEqual(f.followUps[0].delivered_to, ["merge"]);
    assert.equal(f.launch[0].ticket, "merge");
  });
});
