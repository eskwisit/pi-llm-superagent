"use strict";

// Model routing: traits inferred from the user's own model list, picked per task type and requirements.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadMain, sandbox, fakePi, withHome } = require("./helpers.js");

const m = (key, levels = ["low", "medium", "high"], extra = {}) => {
  const [providerId, modelId] = key.split("/");
  return { key, providerId, providerName: providerId, modelId, availableForSubagents: true, supportsReasoning: levels.some((l) => l !== "off"), thinkingLevels: levels, ...extra };
};
const LIST = [
  m("anthropic/claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]),
  m("anthropic/claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"]),
  m("anthropic/claude-haiku-5-5", ["off", "low", "medium", "high"]),
  m("acct2/claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"]),
  m("google/gemini-3.8-flash"),
  m("google/gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"]),
  m("mistral/codestral-large", ["off"]),
  m("qwen/qwen3-coder-480b", ["off"]),
  m("openai/gpt-5", ["low", "medium", "high"]),
  m("openai/gpt-5-mini", ["low", "high"], { availableForSubagents: false }),
];

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

async function setup(settings = {}, models = LIST) {
  const dirs = sandbox();
  const restore = withHome(dirs.home);
  cleanups.push(() => {
    restore();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
  const pi = fakePi(dirs, { settings, models });
  const main = loadMain(pi);
  await main.onLoad();
  const preview = async (tasks, explain) => (await pi.call("superagent_models", { tasks, explain })).routes;
  return { pi, t: main.__t, preview };
}

describe("the user's model list", () => {
  it("uses only models enabled for sub-agents, with provider/model ids", async () => {
    const { pi } = await setup();
    const cfg = await pi.call("superagent_config", {});
    assert.equal(cfg.models.length, 9);
    assert.ok(cfg.models.every((line) => !line.startsWith("openai/gpt-5-mini")));
    assert.match(cfg.models[0], /^anthropic\/claude-opus-5-5: flagship/);
  });

  it("with no model enabled for sub-agents, workers inherit the session model and the user is told", async () => {
    const { pi, preview } = await setup({}, LIST.map((x) => ({ ...x, availableForSubagents: false })));
    const [r] = await preview([{ type: "code" }]);
    assert.equal(r.model, "inherit");
    const cfg = await pi.call("superagent_config", {});
    assert.match(cfg.warnings[0], /enabled for sub-agents/);
  });

  it("infers tiers, families and flags without a vendor list", async () => {
    const { t } = await setup();
    assert.equal(t.inferProfile("x/claude-opus-5-5", "reasoning, thinking: low/high").tier, "flagship");
    assert.equal(t.inferProfile("x/claude-haiku-5-5").tier, "small");
    assert.equal(t.inferProfile("x/gemini-3.5-flash-lite").tier, "tiny");
    assert.equal(t.inferProfile("x/gemini-3.8-flash").context, 5);
    assert.equal(t.inferProfile("x/qwen3-coder-480b").coding, 5);
    assert.equal(t.inferProfile("x/some-reasoner").reasoningModel, true);
    assert.equal(t.inferProfile("x/llama-3.1-8b").tier, "small");
    assert.equal(t.inferProfile("x/unknown-model").tier, "mid");
    assert.equal(t.inferProfile("x/model-preview").unstable, true);
    assert.equal(t.familyOf("acme/zeta-2"), "zeta");
  });
});

describe("routing by type and requirements", () => {
  it("analysis gets a flagship reasoning model, debug a strong coder, a fast test a small model", async () => {
    const { preview } = await setup();
    const [a, d, s] = await preview([{ type: "analysis" }, { type: "debug" }, { type: "test", requirements: { speed: "high", budget: "low" } }]);
    assert.match(a.model, /opus|gpt-5/);
    assert.match(d.model, /opus|sonnet|coder|codestral/);
    assert.match(s.model, /haiku|flash/);
  });

  it("vision keeps only models known to read images; huge context keeps long-context ones", async () => {
    const { preview } = await setup();
    const [v, h] = await preview([{ type: "research", requirements: { vision: true } }, { type: "research", requirements: { context: "huge" } }]);
    assert.doesNotMatch(v.model, /codestral|qwen/);
    assert.match(h.model, /claude|gemini|opus|sonnet/);
  });

  it("differentFrom picks another model family when one is usable", async () => {
    const { preview, t } = await setup();
    const [a, b] = await preview([{ id: "fix", type: "code", requirements: { prefer: ["anthropic/*"] } }, { id: "rev", type: "review", requirements: { differentFrom: ["fix"] } }]);
    assert.equal(t.familyOf(a.model), "claude");
    assert.notEqual(t.familyOf(b.model), "claude");
  });

  it("role-model pins win and add the same model through another account as first fallback", async () => {
    const { preview } = await setup({ roleModels: { code: ["anthropic/claude-sonnet-5-5"] } });
    const [r] = await preview([{ type: "code" }]);
    assert.equal(r.model, "anthropic/claude-sonnet-5-5");
    assert.equal(r.fallbacks[0], "acct2/claude-sonnet-5-5");
    assert.match(r.why, /pinned/);
  });

  it("exclusions are respected and a filtered pin is reported", async () => {
    const { preview, pi } = await setup({ excludeModels: ["anthropic/*", "acct2/*"], roleModels: { analysis: ["anthropic/claude-opus-5-5"] } });
    const out = await pi.call("superagent_models", { tasks: [{ type: "analysis" }] });
    assert.doesNotMatch([out.routes[0].model, ...out.routes[0].fallbacks].join(" "), /anthropic|acct2/);
    assert.ok(out.warnings.some((w) => /not usable here/.test(w)));
    void preview;
  });

  it("suggests a thinking level the chosen model supports", async () => {
    const { preview } = await setup({ roleModels: { analysis: ["google/gemini-3.8-flash"] } });
    const [r] = await preview([{ type: "analysis", requirements: { quality: "max" } }]);
    assert.equal(r.thinking, "high");
  });

  it("rejects invalid requirements", async () => {
    const { pi } = await setup();
    await assert.rejects(pi.call("superagent_models", { tasks: [{ type: "code", requirements: { quality: "ultra" } }] }), /quality must be one of/);
  });
});
