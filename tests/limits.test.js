"use strict";

// Model limits: an account that hit a limit is cooled for every ticket, launches move to a healthy model at
// once, and the worker definitions carry host fallback models on other accounts.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadMain, sandbox, fakePi, withHome } = require("./helpers.js");

const model = (key, providerName) => {
  const [providerId, modelId] = key.split("/");
  return { key, providerId, providerName, modelId, availableForSubagents: true, supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] };
};
const MODELS = [
  model("acct-a/claude-opus-5-5", "Anthropic"),
  model("acct-b/claude-opus-5-5", "Anthropic"),
  model("google/gemini-3.8-pro", "Google"),
];

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

async function setup(settings = { isolation: "worktree" }) {
  const dirs = sandbox();
  const restore = withHome(dirs.home);
  cleanups.push(() => {
    restore();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
  const pi = fakePi(dirs, { settings, models: MODELS });
  const main = loadMain(pi);
  await main.onLoad();
  await pi.call("superagent", {});
  const call = (name, args) => pi.call(`superagent_${name}`, args);
  const state = () => JSON.parse(fs.readFileSync(path.join(dirs.workspace, ".superagent/state.json"), "utf8"));
  return { dirs, call, state };
}

const one = (name, type = "code") => ({ kind: "accept", title: name, name, type, acknowledgement: `On it: ${name}.` });
async function accept(env, text, decision) {
  const intake = await env.call("intake", { text });
  return env.call("route", { decisions: [{ ...decision, trigger_id: intake.trigger_id }] });
}
const account = (m) => m.split("/")[0];

describe("model limits", () => {
  it("a limit cools the account: the ticket fails over, and a later ticket starts on a healthy model at once", async () => {
    const env = await setup();
    const a = await accept(env, "first", one("first"));
    const from = a.launch[0].model;
    const r = await env.call("ticket", { action: "report", ticket: "first", turn: 1, attempt: 1, outcome: "error", error: "429 rate_limit_error: This request would exceed your account's rate limit." });
    assert.match(r.note, /failed over to/);
    const to = r.launch[0].model;
    assert.notEqual(account(to), account(from), "another account, not the limited one");
    assert.ok(env.state().cooldown[account(from)], "the account is cooled");
    const b = await accept(env, "second", one("second"));
    assert.equal(env.state().tickets.second.chain[0], from, "the router still prefers it");
    assert.notEqual(account(b.launch[0].model), account(from), "but the launch moves away at once");
    assert.ok((b.warnings || []).some((w) => /is rate-limited until .* it starts on/.test(w)));
    assert.match(fs.readFileSync(path.join(env.dirs.workspace, ".superagent/tickets/second/turn-1.md"), "utf8"), new RegExp(`Model: ${b.launch[0].model.replace(/[.]/g, "\\.")}`));
  });

  it("a context-window limit fails over without cooling the account", async () => {
    const env = await setup();
    await accept(env, "big", one("big"));
    const r = await env.call("ticket", { action: "report", ticket: "big", turn: 1, attempt: 1, outcome: "error", error: "maximum context length exceeded" });
    assert.match(r.note, /failed over to/);
    assert.equal(env.state().cooldown, undefined);
  });

  it("learns limits from the host's `Model … failed` lines, also when the worker returned on a fallback", async () => {
    const env = await setup();
    const a = await accept(env, "first", one("first"));
    const from = a.launch[0].model;
    const r = await env.call("ticket", {
      action: "report", ticket: "first", turn: 1, attempt: 1, outcome: "returned",
      text: "state: progress\nsummary: halfway\nhuman_action: none\n---\n",
      failures: `Model ${from} failed (PROVIDER_RATE_LIMITED): 429 Too Many Requests`,
    });
    assert.ok((r.warnings || []).some((w) => w.includes(from)));
    assert.ok(env.state().cooldown[account(from)]);
    assert.notEqual(account(r.launch[0].model), account(from), "the next turn runs elsewhere");
  });

  it("an ended cooldown lets the account run again", async () => {
    const env = await setup();
    const a = await accept(env, "first", one("first"));
    const from = a.launch[0].model;
    await env.call("ticket", { action: "report", ticket: "first", turn: 1, attempt: 1, outcome: "error", error: "429 rate limit" });
    const st = env.state();
    st.cooldown[account(from)].until = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(path.join(env.dirs.workspace, ".superagent/state.json"), JSON.stringify(st));
    const b = await accept(env, "second", one("second"));
    assert.equal(b.launch[0].model, from);
  });

  it("worker definitions carry host fallback models: one per account, never the first choice's account", async () => {
    const env = await setup();
    const file = fs.readFileSync(path.join(env.dirs.home, ".agents/subagents/superagent-code.md"), "utf8");
    const m = /^fallbackModels: \[(.*)\]$/m.exec(file);
    assert.ok(m, "the code worker has fallbackModels");
    const list = m[1].split(", ");
    const accounts = list.map(account);
    assert.equal(new Set(accounts).size, accounts.length, "one model per account");
    const preview = await env.call("models", { tasks: [{ type: "code", requirements: {} }] });
    const primary = JSON.stringify(preview).match(/"model":"([^"]+)"/)[1];
    assert.ok(!accounts.includes(account(primary)), "not on the first choice's account");
    assert.match(file, /^thinkingLevel: \S+\nfallbackModels:/m);
  });
});
