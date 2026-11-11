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

describe("tickets that need the results of others (after)", () => {
  const BENCH = {
    kind: "accept", acknowledgement: "On it: running the task with caveman and with pi-mumble, then comparing output and tokens.",
    tickets: [
      { title: "Run with caveman", name: "run caveman", type: "research", scope: "run the task with caveman and record output and token use" },
      { title: "Run with pi-mumble", name: "run mumble", type: "research", scope: "run the task with pi-mumble and record output and token use" },
      { title: "Compare", name: "compare", type: "analysis", scope: "compare the output and token use of both runs", after: ["run caveman", "run-mumble"] },
    ],
  };
  const done = "state: ready\nsummary: Output and tokens recorded.\nhuman_action: none\n---\nEvidence.";

  it("fan-out, fan-in: the parts run in parallel, the step starts after both ended and reads their reports", async () => {
    const env = await setup();
    const { r, out } = await accept(env, "Run it with caveman and with pi-mumble, then compare output and token usage.", BENCH);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(out.launch.map((x) => x.ticket).sort(), ["run-caveman", "run-mumble"], "compare waits");
    assert.deepEqual(env.state().tickets.compare.after, ["run-caveman", "run-mumble"]);
    assert.match(env.brief("run-caveman", 1), /- compare \(analysis\): .* \(starts after run-caveman, run-mumble\)/);
    const l = await env.call("ticket", { action: "list" });
    assert.match(l.open.join("\n"), /compare .* · waits for run-caveman, run-mumble/);
    env.report("run-caveman", 1, done);
    const a = await env.call("ticket", { action: "report", ticket: "run-caveman", turn: 1 });
    assert.equal(a.launch, undefined, "one part is still open");
    env.report("run-mumble", 1, done);
    const b = await env.call("ticket", { action: "report", ticket: "run-mumble", turn: 1 });
    assert.deepEqual(b.launch.map((x) => x.ticket), ["compare"]);
    const brief = env.brief("compare", 1);
    assert.match(brief, /## Results you build on/);
    assert.match(brief, /- run-caveman \(research, completed\)[^\n]*\n  report: `\.superagent\/tickets\/run-caveman\/report-1\.md`: Output and tokens recorded\./);
    assert.match(brief, /- run-mumble \(research, completed\)/);
    const read = await env.call("ticket", { action: "read", ticket: "compare" });
    assert.deepEqual(read.waitsFor, []);
  });

  it("a stopped part releases the step, whose brief says it did not complete", async () => {
    const env = await setup();
    await accept(env, "bench", BENCH);
    env.report("run-caveman", 1, done);
    await env.call("ticket", { action: "report", ticket: "run-caveman", turn: 1 });
    const stop = await env.call("intake", { text: "stop the pi-mumble run" });
    const s = await env.call("route", { decisions: [{ kind: "stop", trigger_id: stop.trigger_id, ticket_id: "run-mumble" }] });
    assert.deepEqual((s.launch || []).map((x) => x.ticket), ["compare"]);
    assert.match(env.brief("compare", 1), /- run-mumble \(research, stopped\)/);
    assert.match(env.brief("compare", 1), /report blocked and name that ticket/);
  });

  it("writers: the parts merge first, then the step starts from the merged checkout", async () => {
    const env = await setup({ isolation: "worktree" });
    const W = {
      kind: "accept", acknowledgement: "On it.",
      tickets: [
        { title: "A", name: "part a", type: "code", scope: "part a" },
        { title: "B", name: "part b", type: "code", scope: "part b" },
        { title: "C", name: "glue", type: "code", scope: "glue a and b", after: ["part a", "part b"] },
      ],
    };
    const { out } = await accept(env, "a and b, then glue them", W);
    assert.deepEqual(out.launch.map((x) => x.ticket).sort(), ["part-a", "part-b"]);
    env.report("part-a", 1, ready());
    await env.call("ticket", { action: "report", ticket: "part-a", turn: 1 });
    env.report("part-b", 1, ready());
    const b = await env.call("ticket", { action: "report", ticket: "part-b", turn: 1 });
    assert.deepEqual(b.launch.map((x) => x.ticket), ["merge"], "the waiting sibling does not hold the merge");
    assert.deepEqual(env.state().tickets.merge.merges, ["part-a", "part-b"]);
    env.report("merge", 1, "state: ready\nsummary: Landed.\nhuman_action: none\n---\nok");
    const m = await env.call("ticket", { action: "report", ticket: "merge", turn: 1 });
    assert.deepEqual(m.launch.map((x) => x.ticket), ["glue"]);
    assert.match(env.brief("glue", 1), /- part-a \(code, completed\)[^\n]*\n[^\n]*Its changes are merged into the main checkout\./);
  });

  it("refuses unknown names, a ticket that waits for itself, loops and after without tickets", async () => {
    const env = await setup();
    const bad = async (tickets, re) => {
      const { r } = await accept(env, `msg ${Math.random()}`, { ...BENCH, tickets });
      assert.equal(r.ok, false);
      assert.match(r.error, re);
    };
    const [x, y] = BENCH.tickets;
    await bad([x, { ...y, after: ["nope"] }], /tickets\[1\]: after names "nope"/);
    await bad([x, { ...y, after: ["run mumble"] }], /cannot wait for itself/);
    await bad([{ ...x, after: ["run mumble"] }, { ...y, after: ["run caveman"] }], /loop/);
    const { r } = await accept(env, "single", { ...one("solo"), after: ["x"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /after is only for tickets\[\]/);
    assert.deepEqual(Object.keys(env.state().tickets), [], "no half-made tickets");
  });
});

describe("a worker splits a broad ticket into parallel tickets", () => {
  const SPLIT_REPORT = [
    "state: dropped",
    "summary: Split into the API, the web app and a check of both.",
    "human_action: none",
    "split: api (code): drop AI cost from apps/api; web (code): hide AI cost in apps/web; check (review) after api, web: check that no AI cost shows on plan",
    "---",
    "Surveyed apps/api and apps/web; no shared files.",
  ].join("\n");

  it("offers the split on the first turn only, then starts one ticket per part under the same request", async () => {
    const env = await setup({ isolation: "worktree" });
    const { r } = await accept(env, "ignore any AI cost reference throughout the project", one("ignore-ai-cost"));
    assert.equal(r.ok, true, r.error);
    const b = env.brief("ignore-ai-cost", 1);
    assert.match(b, /## Parallel parts/);
    assert.match(b, /split: <name \(type\[, key=value…\]\): scope/);
    env.report("ignore-ai-cost", 1, SPLIT_REPORT);
    const out = await env.call("ticket", { action: "report", ticket: "ignore-ai-cost", turn: 1 });
    assert.deepEqual(out.split, ["ignore-ai-cost-api", "ignore-ai-cost-web", "ignore-ai-cost-check"]);
    assert.deepEqual(out.handoff, { kind: "none" });
    assert.deepEqual(out.launch.map((x) => x.ticket).sort(), ["ignore-ai-cost-api", "ignore-ai-cost-web"], "the check waits");
    const s = env.state();
    assert.deepEqual(s.tickets["ignore-ai-cost"].ended.outcome, "split");
    const api = s.tickets["ignore-ai-cost-api"];
    assert.equal(api.parent, "ignore-ai-cost");
    assert.equal(api.mandate.scope, "drop AI cost from apps/api");
    assert.equal(api.mandate.strength, "explicit");
    assert.deepEqual(api.siblings, ["ignore-ai-cost-web", "ignore-ai-cost-check"]);
    assert.deepEqual(s.tickets["ignore-ai-cost-check"].after, ["ignore-ai-cost-api", "ignore-ai-cost-web"]);
    const thread = s.threads[s.triggers[api.origin.triggerId].threads[0]];
    assert.ok(!thread.subscriptions.includes("ignore-ai-cost"), "the split ticket leaves the thread");
    assert.ok(thread.subscriptions.includes("ignore-ai-cost-web"));
    const pb = env.brief("ignore-ai-cost-api", 1);
    assert.match(pb, /The worker of ticket ignore-ai-cost found independent parts/);
    assert.match(pb, /> ignore any AI cost reference/, "each part reads the whole message");
    assert.match(pb, /## Parallel parts/, "a part may split once more");
    assert.match(pb, /already a part of a split/);
  });

  it("a part splits once more with its own requirements per part; the parts join the request's group, and a grandchild never splits", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "ignore any AI cost reference throughout the project", { ...one("ignore-ai-cost"), requirements: { quality: "high" } });
    env.report("ignore-ai-cost", 1, SPLIT_REPORT);
    await env.call("ticket", { action: "report", ticket: "ignore-ai-cost", turn: 1 });
    env.report("ignore-ai-cost-web", 1, [
      "state: dropped", "summary: web splits", "human_action: none",
      "split: ui (code, reasoning=true): the React components; copy (docs, quality=low, speed=high): the help texts of apps/web",
      "---", "two independent parts",
    ].join("\n"));
    const out = await env.call("ticket", { action: "report", ticket: "ignore-ai-cost-web", turn: 1 });
    assert.deepEqual(out.split, ["ignore-ai-cost-web-ui", "ignore-ai-cost-web-copy"], JSON.stringify(out));
    const s = env.state();
    const ui = s.tickets["ignore-ai-cost-web-ui"];
    const copy = s.tickets["ignore-ai-cost-web-copy"];
    assert.equal(ui.parent, "ignore-ai-cost-web");
    assert.deepEqual(ui.req.quality, "high", "the person's requirement stays");
    assert.equal(ui.req.reasoning, true);
    assert.equal(copy.type, "docs");
    assert.equal(copy.req.quality, "low", "a part overrides");
    assert.equal(copy.req.speed, "high");
    assert.deepEqual(ui.siblings.sort(), ["ignore-ai-cost-api", "ignore-ai-cost-check", "ignore-ai-cost-web-copy"], "the parts join the request's other tickets");
    assert.deepEqual(s.tickets["ignore-ai-cost-api"].siblings.sort(), ["ignore-ai-cost-check", "ignore-ai-cost-web-copy", "ignore-ai-cost-web-ui"], "the uncle sees the parts in place of the split ticket");
    assert.doesNotMatch(env.brief("ignore-ai-cost-web-ui", 1), /## Parallel parts/, "two levels at most");
    env.report("ignore-ai-cost-web-ui", 1, "state: dropped\nsummary: x\nhuman_action: none\nsplit: a (code): one; b (code): two\n---\n.");
    const deep = await env.call("ticket", { action: "report", ticket: "ignore-ai-cost-web-ui", turn: 1 });
    assert.equal(deep.split, undefined);
    assert.match(deep.warnings.join("\n"), /split ignored/);
  });

  it("ignores a split with a flag it cannot read", async () => {
    const env = await setup();
    await accept(env, "do it", one("thing"));
    env.report("thing", 1, "state: dropped\nsummary: x\nhuman_action: none\nsplit: a (code, quality=huge): one; b (code): two\n---\n.");
    const out = await env.call("ticket", { action: "report", ticket: "thing", turn: 1 });
    assert.equal(out.split, undefined);
    assert.match(out.warnings.join("\n"), /split ignored \(a: requirements.quality must be one of/);
  });

  it("ignores a split that is not usable, and handles the report as usual", async () => {
    const env = await setup();
    await accept(env, "do it", one("thing"));
    env.report("thing", 1, "state: dropped\nsummary: x\nhuman_action: none\nsplit: only (code): one part\n---\n.");
    const out = await env.call("ticket", { action: "report", ticket: "thing", turn: 1 });
    assert.equal(out.split, undefined);
    assert.match(out.warnings.join("\n"), /split ignored \(it needs 2 to/);
    assert.equal(env.state().tickets.thing.ended.outcome, "dropped");
  });

  it("ignores a split from a worker that reports ready", async () => {
    const env = await setup();
    await accept(env, "do it", one("thing"));
    env.report("thing", 1, "state: ready\nsummary: x\nhuman_action: none\nsplit: a (code): one; b (docs): two\n---\n.");
    const out = await env.call("ticket", { action: "report", ticket: "thing", turn: 1 });
    assert.match(out.warnings.join("\n"), /reports dropped and changes nothing/);
    assert.deepEqual(Object.values(env.state().tickets).filter((t) => t.parent), [], "no part started");
  });
});

describe("git found by the plugin, and project folders that are their own repositories", () => {
  const RADAR = {
    kind: "accept", acknowledgement: "On it: two radar changes.", repo: "radar",
    tickets: [
      { title: "Activity text", name: "activity", type: "code", scope: "show chat text in the activity list" },
      { title: "No pills", name: "pills", type: "code", scope: "remove the help pills" },
    ],
  };

  it("auto: a .git in the workspace root lets writers run in parallel from the start", async () => {
    const env = await setup();
    put(env.dirs, ".git/HEAD", "ref: refs/heads/main\n");
    const { out } = await accept(env, "two things", SPLIT);
    assert.deepEqual(out.launch.map((x) => x.ticket).sort(), ["dark-toggle", "rename-save"]);
    assert.equal(env.state().vcs, "git");
  });

  it("auto: a found repository wins over an earlier none", async () => {
    const env = await setup();
    await accept(env, "first", one("first"));
    env.report("first", 1, ready("isolation: none"));
    await env.call("ticket", { action: "report", ticket: "first", turn: 1 });
    assert.equal(env.state().vcs, "none");
    put(env.dirs, ".git", "gitdir: /elsewhere/.git/worktrees/x\n");
    const { out } = await accept(env, "two things", SPLIT);
    assert.deepEqual(out.launch.map((x) => x.ticket).sort(), ["dark-toggle", "rename-save"]);
    assert.equal(env.state().vcs, "git");
  });

  it("repo: writers of a project folder with git run in parallel worktrees of that repository", async () => {
    const env = await setup();
    put(env.dirs, "radar/.git/HEAD", "ref: refs/heads/main\n");
    const { r, out } = await accept(env, "radar: activity text and no pills", RADAR);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(out.launch.map((x) => x.ticket).sort(), ["activity", "pills"]);
    assert.equal(out.launch.find((x) => x.ticket === "pills").worktree, "radar/.superagent/worktrees/pills");
    const s = env.state();
    assert.equal(s.tickets.pills.repo, "radar");
    assert.deepEqual(s.repos, { radar: "git" });
    assert.equal(s.vcs, undefined, "the workspace root stays unknown");
    const b = env.brief("pills", 1);
    assert.match(b, /- repository: `radar\/`/);
    assert.match(b, /cd radar\n {3}git rev-parse --is-inside-work-tree/);
    assert.match(b, /git worktree add -b superagent\/pills \.superagent\/worktrees\/pills refs\/superagent\/base\/pills/);
  });

  it("repo: one merge per repository, run from that repository", async () => {
    const env = await setup({ isolation: "worktree" });
    await accept(env, "a", { ...one("a"), repo: "app-a" });
    await accept(env, "b", { ...one("b"), repo: "app-b" });
    env.report("a", 1, ready());
    const ra = await env.call("ticket", { action: "report", ticket: "a", turn: 1 });
    assert.equal(ra.launch[0].ticket, "merge");
    env.report("b", 1, ready());
    const rb = await env.call("ticket", { action: "report", ticket: "b", turn: 1 });
    assert.equal(rb.launch[0].ticket, "merge-2", "the merge of app-a does not hold app-b");
    const s = env.state();
    assert.equal(s.tickets.merge.repo, "app-a");
    assert.deepEqual(s.tickets["merge-2"].merges, ["b"]);
    const mb = env.brief("merge-2", 1);
    assert.match(mb, /the git repository `app-b\/`/);
    assert.match(mb, /From the repository folder `app-b\/` \(`cd app-b` from the workspace root\)/);
    assert.match(mb, /- worktree: `\.superagent\/worktrees\/b` \(relative to the repository folder; `app-b\/\.superagent\/worktrees\/b` from the workspace root\)/);
  });

  it("without git, writers in different folders run side by side; the same folder or the root waits", async () => {
    const env = await setup({ isolation: "serial" });
    const a = await accept(env, "a", { ...one("a"), repo: "app-a" });
    assert.equal(a.out.launch[0].ticket, "a");
    assert.match(env.brief("a", 1), /main checkout of the project folder `app-a\/`/);
    const b = await accept(env, "b", { ...one("b"), repo: "app-b" });
    assert.equal(b.out.launch[0].ticket, "b", "another folder: no collision");
    const c = await accept(env, "c", { ...one("c"), repo: "app-a/sub" });
    assert.equal(c.out.launch, undefined, "inside app-a: waits");
    const d = await accept(env, "d", one("d"));
    assert.equal(d.out.launch, undefined, "the workspace root holds every folder: waits");
  });

  it("refuses a repo outside the workspace", async () => {
    const env = await setup();
    for (const repo of ["../other", "/Users/x/radar", "a/../b"]) {
      const { r } = await accept(env, `msg ${repo}`, { ...one("x"), repo });
      assert.equal(r.ok, false, repo);
      assert.match(r.error, /repo must be a folder relative to the workspace root/);
    }
    assert.deepEqual(Object.keys(env.state().tickets), []);
  });
});
