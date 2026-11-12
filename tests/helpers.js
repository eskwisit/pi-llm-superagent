"use strict";

/**
 * Test helpers for LLM Superagent. No dependencies: main.js is compiled as a fresh CommonJS module
 * per test with its own fake `pi` global, and a few internal functions are re-exported under
 * `__t` so the logic can be exercised directly. The fake host keeps the workspace, the plugin
 * data directory and the home directory in a temporary folder.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "main.js");

// internal names re-exported for the tests; a name that no longer exists comes back undefined
const INTERNALS = ["GATEWAY", "ACTIVATION_QUERIES",
  "parseCatalog", "inferProfile", "profileOf", "familyOf", "routeTask", "normalizeRequirements", "routingContext",
  "parseReport", "wordCount", "slug", "gate", "revalidate", "policyEffects", "policyVersion", "ticketStage", "waitsForPerson",
  "installPersonas", "removePersonas", "TOOLS", "TASK_TYPES", "AGENTS", "MARKER", "STATE_FILE", "DEFAULT_RULES",
];

/** Compile a fresh copy of main.js bound to `pi`. Returns `{ ...exports, __t }`. */
function loadMain(pi) {
  const src = fs.readFileSync(MAIN, "utf8");
  const exportsLine =
    "\nmodule.exports.__t = {" +
    INTERNALS.map((n) => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(", ") +
    " };\n";
  const bind = "const pi = module.__pi;";
  const m = new module.constructor(MAIN, module);
  m.filename = MAIN;
  m.paths = module.paths;
  m.__pi = pi;
  const directive = /^\s*(["'])use strict\1;?/;
  const body = directive.test(src) ? src.replace(directive, (d) => `${d} ${bind}`) : `${bind}\n${src}`;
  m._compile(body + exportsLine, MAIN);
  return m.exports;
}

/** A temporary sandbox: workspace, plugin data dir and HOME. */
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-test-"));
  const dirs = {
    base,
    workspace: path.join(base, "workspace"),
    data: path.join(base, "data"),
    home: path.join(base, "home"),
  };
  for (const d of [dirs.workspace, dirs.data, dirs.home]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/**
 * A fake `pi`: pi.fs over `dirs.workspace` (paths are root-relative and may not escape it),
 * settings in memory, getDataPath → `dirs.data`, and spies on registered tools.
 */
function fakePi(dirs, { settings = {}, models = [] } = {}) {
  const abs = (p) => {
    const full = path.resolve(dirs.workspace, p);
    if (path.relative(dirs.workspace, full).startsWith("..")) throw new Error(`outside the workspace: ${p}`);
    return full;
  };
  const writes = [];
  const tools = new Map();
  const unregistered = [];
  // checks (acceptance tests and proofs) are off unless a test turns them on: most tests are about other things
  const store = { proofRounds: 0, ...settings };
  const pi = {
    writes, tools, unregistered, store, modelList: models,
    fs: {
      readText: async (p) => fs.readFileSync(abs(p), "utf8"),
      writeText: async (p, content) => {
        writes.push(p);
        fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
        fs.writeFileSync(abs(p), content);
      },
      list: async (p) => fs.readdirSync(abs(p), { withFileTypes: true }).map((e) => ({
        name: e.name,
        path: path.posix.join(p, e.name),
        isDirectory: e.isDirectory(),
      })),
    },
    plugin: {
      getSettings: async () => JSON.parse(JSON.stringify(store)),
      setSettings: async (partial) => { Object.assign(store, JSON.parse(JSON.stringify(partial))); },
      getDataPath: async () => dirs.data,
    },
    models: { list: async () => JSON.parse(JSON.stringify(pi.modelList)) },
    agent: {
      registerTool: async (tool) => { tools.set(tool.name, tool); },
      unregisterTool: async (name) => { unregistered.push(name); tools.delete(name); },
    },
    /** Call a registered tool the way the host does. */
    call: (name, args) => tools.get(name).execute(args, { sessionId: "s1", log: () => {} }),
  };
  return pi;
}

/** Write a workspace file. */
function put(dirs, rel, content) {
  const full = path.join(dirs.workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Read a workspace file, or null. */
function get(dirs, rel) {
  try {
    return fs.readFileSync(path.join(dirs.workspace, rel), "utf8");
  } catch {
    return null;
  }
}

/** Point HOME at the sandbox for the duration of a test; returns the restore function. */
function withHome(home) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  };
}

/** Parse persona frontmatter the simple way PI-Desktop documents it. Returns { fields, dups }. */
function frontmatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fields = {};
  const dups = [];
  if (lines[0] !== "---") return { fields, dups };
  for (const line of lines.slice(1)) {
    if (line === "---") break;
    const m = /^([A-Za-z][A-Za-z0-9_\- ]*):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    if (key in fields) dups.push(key);
    fields[key] = m[2].trim();
  }
  return { fields, dups };
}

module.exports = { ROOT, loadMain, sandbox, fakePi, put, get, withHome, frontmatter };
