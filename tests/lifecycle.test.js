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
  it("installs the five worker personas and registers the seven tools", async () => {
    const { pi, main, target, t } = setup();
    await main.onLoad();
    for (const a of t.AGENTS) assert.ok(fs.existsSync(path.join(target, `${a}.md`)), a);
    assert.deepEqual([...pi.tools.keys()].sort(), ["superagent_config", "superagent_eval_decide", "superagent_intake", "superagent_models", "superagent_reply", "superagent_route", "superagent_ticket"]);
    const cfg = await pi.call("superagent_config", {});
    assert.match(cfg.personas, /installed/);
    assert.equal(cfg.policy.mode, "observe");
    assert.deepEqual(cfg.policy.rules.map((r) => r.id), ["copy", "visual"]);
    assert.deepEqual(cfg.policy.admission, { listedUnaddressed: "inferred", unlistedAddressed: "ignore", unlistedUnaddressed: "ignore" });
  });

  it("removes its personas on unload but keeps one the user edited", async () => {
    const { main, target } = setup();
    await main.onLoad();
    fs.appendFileSync(path.join(target, "superagent-worker-docs.md"), "\nmy edit\n");
    await main.onUnload();
    assert.ok(!fs.existsSync(path.join(target, "superagent-worker-code.md")));
    assert.ok(fs.existsSync(path.join(target, "superagent-worker-docs.md")));
  });

  it("saves policy, slots, role models and team sections, and validates them", async () => {
    const { pi, main } = setup();
    await main.onLoad();
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
  it("declares exactly the tools the code registers, with the same schemas and the models.list permission", () => {
    const { t } = setup();
    const declared = Object.fromEntries(manifest.contributes.agentTools.map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(declared).sort(), t.TOOLS.map((x) => x.name).sort());
    for (const tool of t.TOOLS) {
      assert.deepEqual(declared[tool.name].schema, JSON.parse(JSON.stringify(tool.schema)), tool.name);
      assert.equal(declared[tool.name].description, tool.description);
    }
    assert.ok(manifest.permissions.includes("models.list"));
    assert.equal(manifest.id, "eskwisit.llm-superagent");
    assert.deepEqual(manifest.fs.write.scope, [".superagent/**"]);
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

  it("ships the three default team sections", () => {
    for (const name of ["communication", "scope", "delivery"]) {
      assert.ok(fs.readFileSync(path.join(ROOT, "prompts", "team", `${name}.md`), "utf8").trim().length > 100, name);
    }
  });
});
