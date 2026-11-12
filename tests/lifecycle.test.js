"use strict";

// Load and unload, config, and the manifest and persona files staying in step with the code.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, loadMain, sandbox, fakePi, withHome, frontmatter } = require("./helpers.js");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function setup(settings) {
  const dirs = sandbox();
  const restore = withHome(dirs.home);
  cleanups.push(() => {
    restore();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
  const pi = fakePi(dirs, { settings });
  const main = loadMain(pi);
  return { dirs, pi, main, t: main.__t, target: path.join(dirs.home, ".agents", "subagents") };
}

describe("load and unload", () => {
  it("registers one tool at load; its first call installs the two worker personas and routes every operation", async () => {
    const { pi, main, target, t } = setup();
    await main.onLoad();
    // one tool: one line in the host's on-demand list, one ToolSearch activation
    assert.deepEqual([...pi.tools.keys()], ["superagent"]);
    // lazy workers: idle sessions get no Task-tool entries for them
    for (const a of t.AGENTS) assert.ok(!fs.existsSync(path.join(target, `${a}.md`)), a);
    const cfg = await pi.call("superagent", {});
    assert.deepEqual(t.AGENTS, ["superagent-writer", "superagent-reader"]);
    for (const a of t.AGENTS) assert.ok(fs.existsSync(path.join(target, `${a}.md`)), a);
    assert.match(cfg.operations, /\{ config: \{…\} \}.*\{ ticket: \{…\} \}/);
    assert.deepEqual(Object.keys(t.OPS), ["config", "models", "intake", "route", "eval_decide", "reply", "ticket"]);
    assert.match(cfg.personas, /installed/);
    assert.equal(cfg.policy.mode, "observe");
    assert.deepEqual(cfg.policy.rules.map((r) => r.id), ["copy", "visual"]);
    assert.deepEqual(cfg.policy.admission, { listedUnaddressed: "inferred", unlistedAddressed: "ignore", unlistedUnaddressed: "ignore" });
    // dispatch: exactly one operation key, each an object
    await assert.rejects(pi.call("superagent", { intake: { text: "x" }, ticket: {} }), /one operation per call/);
    await assert.rejects(pi.call("superagent", { nope: {} }), /unknown operation nope/);
    await assert.rejects(pi.call("superagent", { ticket: "list" }), /ticket must be an object/);
    const list = await pi.call("superagent", { ticket: { action: "list" } });
    assert.equal(list.slots, "0/6 running");
  });

  it("removes its personas on unload but keeps one the user edited", async () => {
    const { pi, main, target } = setup();
    await main.onLoad();
    await pi.call("superagent", {});
    fs.appendFileSync(path.join(target, "superagent-reader.md"), "\nmy edit\n");
    await main.onUnload();
    assert.ok(!fs.existsSync(path.join(target, "superagent-writer.md")));
    assert.ok(fs.existsSync(path.join(target, "superagent-reader.md")));
  });

  it("installs the workers with thinking levels that excludeThinking allows, and rewrites them when it changes", async () => {
    const { pi, main, target } = setup();
    const level = (a) => frontmatter(fs.readFileSync(path.join(target, `${a}.md`), "utf8")).fields.thinkinglevel;
    await main.onLoad();
    await pi.call("superagent", {});
    // the Task tool takes no thinking level: the definition's thinkingLevel is the one the worker runs at
    for (const a of ["superagent-writer", "superagent-reader"]) assert.equal(level(a), "medium", a);
    const out = await pi.call("superagent_config", { action: "set", excludeThinking: ["max"] });
    assert.match(out.personas, /installed or updated: .*superagent-writer\.md/);
    assert.equal(level("superagent-writer"), "high");
    await pi.call("superagent_config", { action: "set", excludeThinking: ["low", "medium", "high", "xhigh", "max"] });
    assert.equal(level("superagent-reader"), "minimal");
    assert.equal(level("superagent-writer"), "minimal");
    // a rewritten thinking level is not a user edit: unload still removes the file
    await main.onUnload();
    assert.ok(!fs.existsSync(path.join(target, "superagent-writer.md")));
  });

  it("installs the workers with the stored excludeThinking on the first call", async () => {
    const { pi, main, target } = setup({ excludeThinking: [] });
    await main.onLoad();
    await pi.call("superagent", {});
    assert.equal(frontmatter(fs.readFileSync(path.join(target, "superagent-writer.md"), "utf8")).fields.thinkinglevel, "high");
  });

  it("drops the worker-* and superagent-worker-* copies older releases installed, but leaves files it did not write", async () => {
    const { pi, main, target, t } = setup();
    fs.mkdirSync(target, { recursive: true });
    const ours = `---\nname: x\ndescription: old worker. ${t.MARKER}\n---\n`;
    for (const old of ["worker-code.md", "worker-docs.md", "superagent-worker-review.md"]) fs.writeFileSync(path.join(target, old), ours);
    fs.writeFileSync(path.join(target, "worker-analysis.md"), "---\nname: worker-analysis\ndescription: my own agent\n---\n");
    await main.onLoad();
    await pi.call("superagent", {});
    for (const old of ["worker-code.md", "worker-docs.md", "superagent-worker-review.md"]) assert.ok(!fs.existsSync(path.join(target, old)), old);
    assert.ok(fs.existsSync(path.join(target, "worker-analysis.md")));
    for (const a of t.AGENTS) assert.match(a, /^superagent-/);
  });

  it("saves policy, slots, role models and team sections, and validates them", async () => {
    const { pi, main } = setup();
    await main.onLoad();
    await pi.call("superagent", {});
    const out = await pi.call("superagent_config", {
      action: "set", mode: "auto", maxWorkers: 2, roleModels: { code: ["x/m-1"] }, exclude: ["google/*"],
      admission: { unlistedAddressed: "explicit" }, team: { delivery: "Always open a PR." }, show: ["delivery"],
    });
    assert.equal(out.policy.mode, "auto");
    assert.equal(out.policy.admission.unlistedAddressed, "explicit");
    assert.equal(out.maxWorkers, 2);
    assert.equal(out.team_delivery, "Always open a PR.");
    assert.equal(out.promptRevision, 1);
    assert.deepEqual(pi.store.excludeModels, ["google/*"]);
    await assert.rejects(pi.call("superagent_config", { action: "set", mode: "sometimes" }), /mode must be one of/);
    await assert.rejects(pi.call("superagent_config", { action: "set", roleModels: { nope: ["x"] } }), /unknown task type/);
    await assert.rejects(pi.call("superagent_config", { action: "set", admission: { listedUnaddressed: "explicit" } }), /must be one of inferred, ignore/);
  });
});

describe("manifest, personas, prompts", () => {
  it("declares exactly the one tool the code registers, with the same schema and the models.list permission", () => {
    const { t } = setup();
    assert.deepEqual(manifest.contributes.agentTools.map((x) => x.name), [t.GATEWAY.name]);
    const declared = manifest.contributes.agentTools[0];
    assert.deepEqual(declared.schema, JSON.parse(JSON.stringify(t.GATEWAY.schema)));
    assert.equal(declared.description, t.GATEWAY.description);
    // every team tool is one operation key carrying its own schema and description
    for (const tool of t.TOOLS) {
      const key = tool.name.replace(/^superagent_/, "");
      const op = declared.schema.properties[key];
      assert.ok(op, key);
      assert.deepEqual(op.properties, JSON.parse(JSON.stringify(tool.schema.properties)), key);
      assert.ok(!/^LLM Superagent|llm-superagent skill/.test(op.description), key);
    }
    assert.ok(manifest.permissions.includes("models.list"));
    assert.equal(manifest.id, "eskwisit.llm-superagent");
    assert.deepEqual(manifest.fs.write.scope, [".superagent/**"]);
  });

  it("the skill names the one tool and its operations, and no removed tool", () => {
    const { t } = setup();
    const skill = fs.readFileSync(path.join(ROOT, "skills", "llm-superagent.md"), "utf8");
    for (const key of Object.keys(t.OPS)) assert.ok(skill.includes(`\`${key}:`) || skill.includes(`{ ${key}:`), key);
    assert.ok(!/superagent_(config|models|intake|route|eval_decide|reply|ticket)\b/.test(skill));
    assert.ok(!/superagent-(code|docs|review|research|analysis)\b/.test(skill));
  });

  it("ships one persona per worker, without a model, with the marker and the report contract", () => {
    const { t } = setup();
    assert.deepEqual(fs.readdirSync(path.join(ROOT, "subagents")).sort(), t.AGENTS.map((a) => `${a}.md`).sort());
    for (const a of t.AGENTS) {
      const text = fs.readFileSync(path.join(ROOT, "subagents", `${a}.md`), "utf8");
      const { fields, dups } = frontmatter(text);
      assert.equal(fields.name, a);
      assert.deepEqual(dups, []);
      assert.ok(!("model" in fields), `${a} must not pin a model`);
      assert.ok(fields.description.endsWith(t.MARKER), a);
      assert.match(text, /`human_action`/);
    }
  });

  it("names no third party anywhere in the package except the README credit", () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", "dist"].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name !== "README.md") files.push(p);
      }
    };
    walk(ROOT);
    const needle = ["deep", "seek"].join("");
    for (const f of files) assert.ok(!fs.readFileSync(f, "utf8").toLowerCase().includes(needle), path.relative(ROOT, f));
  });

  it("ships english and chinese texts and the apache-2.0 license", () => {
    for (const lang of ["en", "zh-CN"]) {
      for (const key of ["name", "description", "safetyNotes"]) assert.ok(manifest.i18n[lang][key], `${lang}.${key}`);
    }
    assert.equal(manifest.i18n.en.safetyNotes, manifest.safetyNotes);
    assert.equal(manifest.i18n.en.description, manifest.description);
    for (const tool of manifest.contributes.agentTools) assert.ok(manifest.i18n["zh-CN"].safetyNotes.includes(tool.name), tool.name);
    assert.equal(manifest.license, "Apache-2.0");
    assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
  });

  it("ships the three default team sections and a role file for every ticket type that names one", () => {
    const { t } = setup();
    for (const name of ["communication", "scope", "delivery"]) {
      assert.ok(fs.readFileSync(path.join(ROOT, "prompts", "team", `${name}.md`), "utf8").trim().length > 100, name);
    }
    const roles = new Set(Object.values(t.TASK_TYPES).map((x) => x.role).filter(Boolean));
    assert.deepEqual([...roles].sort(), ["analysis", "code", "docs", "research", "review"]);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, "prompts", "roles")).sort(), [...roles].sort().map((r) => `${r}.md`));
    for (const r of roles) assert.ok(fs.readFileSync(path.join(ROOT, "prompts", "roles", `${r}.md`), "utf8").trim().length > 100, r);
    // merge and proof carry their own brief and name no role
    assert.equal(t.TASK_TYPES.merge.role, undefined);
    assert.equal(t.TASK_TYPES.proof.role, undefined);
  });
});
