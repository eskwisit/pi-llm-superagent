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
  it("registers all eight tools at load; the gateway's first call installs the five worker personas", async () => {
    const { pi, main, target, t } = setup();
    await main.onLoad();
    // the host reads a session's plugin tools when a prompt starts: a tool registered during a turn
    // is missing from ToolSearch until the next prompt, so every tool must exist before the first call
    assert.deepEqual([...pi.tools.keys()], ["superagent", "superagent_config", "superagent_models", "superagent_intake", "superagent_route", "superagent_eval_decide", "superagent_reply", "superagent_ticket"]);
    // lazy workers: idle sessions get no Task-tool entries for them
    for (const a of t.AGENTS) assert.ok(!fs.existsSync(path.join(target, `${a}.md`)), a);
    const cfg = await pi.call("superagent", {});
    assert.equal(pi.tools.size, 8);
    for (const a of t.AGENTS) assert.ok(fs.existsSync(path.join(target, `${a}.md`)), a);
    assert.match(cfg.activated, /superagent_ticket are registered/);
    for (const q of t.ACTIVATION_QUERIES) assert.ok(cfg.activated.includes(`"${q}"`), q);
    assert.match(cfg.personas, /installed/);
    assert.equal(cfg.policy.mode, "observe");
    assert.deepEqual(cfg.policy.rules.map((r) => r.id), ["copy", "visual"]);
    assert.deepEqual(cfg.policy.admission, { listedUnaddressed: "inferred", unlistedAddressed: "ignore", unlistedUnaddressed: "ignore" });
  });

  it("removes its personas on unload but keeps one the user edited", async () => {
    const { pi, main, target } = setup();
    await main.onLoad();
    await pi.call("superagent", {});
    fs.appendFileSync(path.join(target, "superagent-docs.md"), "\nmy edit\n");
    await main.onUnload();
    assert.ok(!fs.existsSync(path.join(target, "superagent-code.md")));
    assert.ok(fs.existsSync(path.join(target, "superagent-docs.md")));
  });

  it("installs the workers with thinking levels that excludeThinking allows, and rewrites them when it changes", async () => {
    const { pi, main, target } = setup();
    const level = (a) => frontmatter(fs.readFileSync(path.join(target, `${a}.md`), "utf8")).fields.thinkinglevel;
    await main.onLoad();
    await pi.call("superagent", {});
    // the Task tool takes no thinking level: the definition's thinkingLevel is the one the worker runs at
    for (const a of ["superagent-code", "superagent-analysis", "superagent-review", "superagent-research"]) assert.equal(level(a), "medium", a);
    assert.equal(level("superagent-docs"), "low");
    const out = await pi.call("superagent_config", { action: "set", excludeThinking: ["max"] });
    assert.match(out.personas, /installed or updated: .*superagent-code\.md/);
    assert.equal(level("superagent-code"), "high");
    await pi.call("superagent_config", { action: "set", excludeThinking: ["low", "medium", "high", "xhigh", "max"] });
    assert.equal(level("superagent-docs"), "minimal");
    assert.equal(level("superagent-code"), "minimal");
    // a rewritten thinking level is not a user edit: unload still removes the file
    await main.onUnload();
    assert.ok(!fs.existsSync(path.join(target, "superagent-code.md")));
  });

  it("installs the workers with the stored excludeThinking on the first call", async () => {
    const { pi, main, target } = setup({ excludeThinking: [] });
    await main.onLoad();
    await pi.call("superagent", {});
    assert.equal(frontmatter(fs.readFileSync(path.join(target, "superagent-code.md"), "utf8")).fields.thinkinglevel, "high");
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
  it("declares exactly the tools the code registers, with the same schemas and the models.list permission", () => {
    const { t } = setup();
    const declared = Object.fromEntries(manifest.contributes.agentTools.map((x) => [x.name, x]));
    const all = [t.GATEWAY, ...t.TOOLS];
    assert.deepEqual(Object.keys(declared).sort(), all.map((x) => x.name).sort());
    for (const tool of all) {
      assert.deepEqual(declared[tool.name].schema, JSON.parse(JSON.stringify(tool.schema)), tool.name);
      assert.equal(declared[tool.name].description, tool.description);
    }
    assert.ok(manifest.permissions.includes("models.list"));
    assert.equal(manifest.id, "eskwisit.llm-superagent");
    assert.deepEqual(manifest.fs.write.scope, [".superagent/**"]);
  });

  it("activates all eight tools with the two ToolSearch queries the gateway and the skill give", () => {
    const { t } = setup();
    // PI-Desktop's ToolSearch ranking (agent-runtime findDeferredTools): plugin tools are named
    // plugin_<id>_<name>, a query activates at most four matches, ties keep registration order
    const catalog = [
      { name: "Browser", description: "Open a page in the browser panel; a gateway to the web." },
      ...[t.GATEWAY, ...t.TOOLS].map((x) => ({ name: `plugin_eskwisit_llm_superagent_${x.name}`, description: x.description })),
    ];
    const search = (query) => {
      const n = query.toLowerCase();
      const words = n.split(/[\s,;|/]+/).filter(Boolean);
      return catalog.map((tool) => {
        const o = tool.name.toLowerCase();
        const d = tool.description.toLowerCase();
        let score = o === n ? 1e4 : o.includes(n) ? 2e3 : 0;
        for (const w of words) score += (o.includes(w) ? 300 : 0) + (d.includes(w) ? 25 : 0);
        return { name: tool.name, score };
      }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map((r) => r.name);
    };
    const activated = t.ACTIVATION_QUERIES.flatMap(search);
    assert.deepEqual(activated.sort(), catalog.slice(1).map((x) => x.name).sort());
    // the skill gives the same queries
    const skill = fs.readFileSync(path.join(ROOT, "skills", "llm-superagent.md"), "utf8").replace(/\s+/g, " ");
    for (const q of t.ACTIVATION_QUERIES) assert.ok(skill.includes(`\`${q}\``), q);
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

  it("ships the three default team sections", () => {
    for (const name of ["communication", "scope", "delivery"]) {
      assert.ok(fs.readFileSync(path.join(ROOT, "prompts", "team", `${name}.md`), "utf8").trim().length > 100, name);
    }
  });
});
