"use strict";

/**
 * LLM Superagent — PI-Desktop plugin main process.
 *
 * The main agent acts as the orchestrator of an autonomous team (skills/llm-superagent.md). The
 * person's chat is the Source: each message becomes a Trigger on a Thread. A message that replies
 * on a ticket's thread fans out to that ticket's worker as a follow-up; any other message passes
 * the gate (allowed senders, admission table, accept mode) and comes to the orchestrator as a
 * candidate for Eval. An accepted request becomes a Ticket with an immutable Mandate. Its work runs
 * in Assignments — one worker session on one model — made of turns, each a sub-agent run that
 * ends with a structured Report. Tickets subscribe to threads, hand back what is not theirs,
 * resume when the person writes again, and end with an outcome.
 *
 * Every worker runs on a model picked from the models the user enabled for sub-agents
 * (pi.models.list), by the ticket's type of task and its requirements: any provider, any LLM.
 *
 *   superagent_config       policy, slots, pause, role models, trait overrides, team sections
 *   superagent_models       preview model routing
 *   superagent_intake       a person's message -> follow-up fan-out, or a candidate card
 *   superagent_route        accept | attach | stop | ignore for explicit candidates
 *   superagent_eval_decide  rule assessment of a proactive (inferred) candidate
 *   superagent_reply        purpose-checked messages to the person
 *   superagent_ticket       list | read | report | retry | status | note | unsubscribe | requeue | dismiss | merge
 *
 * One message may start several tickets, which run in parallel. Workers that change files never share a checkout:
 * each works in its own git worktree on branch superagent/<ticket>, and a ready branch is queued for a merge ticket
 * that lands the branches in the person's checkout, one merge at a time. Until a worker confirms git, and in a
 * workspace without git, such workers run one at a time in the shared checkout instead.
 *
 * State lives in the workspace under .superagent/ (host pi.fs, manifest scope). node:fs is used
 * only to install the worker personas in ~/.agents/subagents, remove them on unload, and read this
 * plugin's own default team sections. No network access, no process execution.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------- task types: one worker persona each, with the traits its model needs ----------
const TRAITS = ["reasoning", "coding", "writing", "context", "speed", "cost"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Thinking levels workers never get unless the person allows them (setting excludeThinking). */
const DEFAULT_EXCLUDE_THINKING = ["high", "xhigh", "max"];

const TASK_TYPES = {
  code: { agent: "superagent-worker-code", weights: { coding: 5, reasoning: 3, context: 2 }, thinking: "medium", about: "implement a change: feature, fix, refactor", writes: true },
  debug: { agent: "superagent-worker-code", weights: { coding: 4, reasoning: 5, context: 2 }, thinking: "high", about: "find and fix the root cause of a failure", writes: true },
  test: { agent: "superagent-worker-code", weights: { coding: 4, reasoning: 2, speed: 2, cost: 1 }, thinking: "medium", about: "write or repair tests", writes: true },
  research: { agent: "superagent-worker-research", weights: { reasoning: 3, context: 4, speed: 2, cost: 1 }, thinking: "medium", about: "investigate code, docs or behaviour and answer with evidence; read-only" },
  analysis: { agent: "superagent-worker-analysis", weights: { reasoning: 5, context: 3, coding: 1 }, thinking: "high", about: "design, tradeoff, data or root-cause analysis; read-only" },
  review: { agent: "superagent-worker-review", weights: { reasoning: 5, coding: 3, context: 3 }, thinking: "high", about: "review a change or another ticket's result for defects; read-only" },
  docs: { agent: "superagent-worker-docs", weights: { writing: 5, reasoning: 2, context: 2 }, thinking: "low", about: "write or update documentation and prose", writes: true },
  // internal: started by the plugin, never accepted from a message
  merge: { agent: "superagent-worker-code", weights: { coding: 4, reasoning: 4, context: 2 }, thinking: "medium", about: "land finished ticket branches in the person's checkout and resolve their conflicts", writes: true, internal: true },
  spec: { agent: "superagent-worker-code", weights: { coding: 3, reasoning: 2, speed: 2, cost: 3 }, thinking: "low", about: "write the acceptance checklist and tests of a change from its request, apart from its implementation", writes: true, internal: true },
  proof: { agent: "superagent-worker-review", weights: { reasoning: 3, coding: 3, speed: 1, cost: 3 }, thinking: "medium", about: "check that finished work passes its acceptance tests and fits the request and the codebase, and list its defects; read-only", internal: true },
};
const AGENTS = [...new Set(Object.values(TASK_TYPES).map((t) => t.agent))];
/** Task types a decision may accept; `merge` is the plugin's own. */
const ACCEPT_TYPES = Object.keys(TASK_TYPES).filter((k) => !TASK_TYPES[k].internal);
/** Ticket types that change files: each runs in its own git worktree, or alone in the shared checkout. */
const writes = (t) => !!TASK_TYPES[t.type].writes;
const MARKER = "Use only from the llm-superagent skill.";

const SOURCE = "chat";
const PERSON = "person";
const ROOT_DIR = ".superagent";
const STATE_FILE = `${ROOT_DIR}/state.json`;
const RULE_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const REPORT_STATES = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];
const LIMIT = /\b429\b|rate.?limit|quota|usage.?limit|limit (reached|exceeded|hit)|too many requests|context.?(length|window)|maximum context|token limit|overload|capacity|insufficient.?(credit|balance|funds)/i;
/** Limits of a provider account (not of one request, such as a context window): they hold for every ticket. */
const ACCOUNT_LIMIT = /\b429\b|rate.?limit|quota|usage.?limit|limit (reached|exceeded|hit)|too many requests|overload|capacity|insufficient.?(credit|balance|funds)/i;
const TRANSIENT = /\b(408|5\d\d)\b|timed? ?out|timeout|ECONN|ETIMEDOUT|socket|network|temporar|unavailable|connection (reset|refused)/i;
const TURN_RETRIES = 3; // attempts of one turn after passing failures
const GO_ON_LIMIT = 2; // turns that may end in `progress` in a row before the ticket idles
const STALE_TURN_MS = 90 * 60 * 1000; // a turn running longer was cut off (workers stop at 60 min)
const MAX_FALLBACKS = 3;
const LIMIT_COOLDOWN_MS = 15 * 60 * 1000; // a provider account that hit a limit gets no new launch for this long
/** The lines the host adds to a sub-agent result when a model failed and it moved on: `Model <key> failed (<CODE>): <message>`. */
const MODEL_FAILED = /Model (\S+) failed \(([A-Z_]+)\):\s*([^\n]*)/g;
const NOTE_WORDS = 30; // routing note
const IM_WORDS = 100; // any message to the person
const NOTE_FACT_WORDS = 100; // a note about other work
const DEFAULT_WORKERS = 6;
const MAX_WORKERS = 8;
const DEFAULT_EVAL_TIMEOUT = 120;
const MAX_SPLIT = 8; // tickets one message may start
const DEFAULT_PROOF_ROUNDS = 3; // proof runs of a check group before the person decides; 0 turns checks off
const MAX_PROOF_ROUNDS = 6;
/** How a writer ticket is checked: full (acceptance tests written in parallel, then a proof), proof (a proof only) or none. */
const CHECK_LEVELS = ["full", "proof", "none"];
const DEFAULT_CHECK = { code: "full", debug: "full", test: "proof", docs: "none" };
const ISOLATION = ["auto", "worktree", "serial"];
const WORKTREE_DIR = ".superagent/worktrees";

const REQ_ENUMS = {
  quality: ["low", "normal", "high", "max"],
  speed: ["low", "normal", "high"],
  budget: ["low", "normal", "high"],
  context: ["short", "normal", "long", "huge"],
};
const REQ_KEYS = [...Object.keys(REQ_ENUMS), "vision", "reasoning", "thinking", "differentFrom", "prefer", "avoid"];

let personaStatus = "not installed yet";
let registered = [];
let seqCounter = 0;
/** Monotonic order for turns created within the same millisecond. */
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000);
let queue = Promise.resolve();
/** One tool call at a time: workers report concurrently and every call is a read-modify-write of the state. */
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- helpers ----------
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
const clamp = (n) => Math.max(1, Math.min(5, n));
const round = (n) => Math.round(n * 100) / 100;

function fail(message) {
  const e = new Error(message);
  e.code = "INVALID_ARGUMENT";
  throw e;
}


/** Shell-style glob (* ? [..]) matched case-insensitively against the whole id. */
function globMatch(pattern, value) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        let set = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (set.startsWith("!")) set = "^" + set.slice(1);
        re += `[${set}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}
const matchesAny = (id, patterns) => patterns.some((p) => globMatch(p, id) || globMatch(p, tail(id)));
const tail = (id) => id.split("/").pop().toLowerCase();

// ---------- catalog and model profiles ----------
/**
 * Normalize the catalog: strings "id" or "id — description" (the form of the "Available models
 * for delegation" list), or objects { id, description }. Duplicates are dropped.
 */
function parseCatalog(models) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(models) ? models : []) {
    let id = "";
    let desc = "";
    if (typeof m === "string") {
      const s = m.trim().replace(/^[-*]\s+/, "");
      const parts = s.split(/\s+[—–-]+\s+/);
      id = parts[0].replace(/`/g, "").trim();
      desc = parts.slice(1).join(" — ");
    } else if (isObj(m)) {
      id = str(m.id).trim();
      desc = str(m.description || m.desc);
    }
    if (!id || /\s/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, desc });
  }
  return out;
}

const FAMILIES = [
  ["claude", /claude|opus|sonnet|haiku/],
  ["openai", /^(gpt|o[1-9]|chatgpt|codex)/],
  ["gemini", /gemini|gemma/],
  ["qwen", /qwen|qwq/],
  ["llama", /llama/],
  ["mistral", /mistral|mixtral|codestral|devstral|pixtral|magistral/],
  ["grok", /grok/],
  ["kimi", /kimi|moonshot/],
  ["glm", /glm|zhipu/],
  ["minimax", /minimax/],
];
function familyOf(id) {
  const t = tail(id);
  for (const [name, re] of FAMILIES) if (re.test(t)) return name;
  return t.split(/[-_.:@]/)[0] || t;
}

const TIER_BONUS = { flagship: 0.4, mid: 0, small: -0.2, tiny: -0.4 };
const TIER_BASE = {
  flagship: { reasoning: 5, coding: 4, writing: 5, context: 3, speed: 2, cost: 1 },
  mid: { reasoning: 4, coding: 4, writing: 4, context: 3, speed: 3, cost: 3 },
  small: { reasoning: 3, coding: 3, writing: 3, context: 3, speed: 5, cost: 4 },
  tiny: { reasoning: 2, coding: 2, writing: 2, context: 3, speed: 5, cost: 5 },
};

/**
 * Infer a trait profile (1–5 per trait; vision true/false/null) from the model id and its
 * catalog description. Heuristic and vendor-neutral: size words (opus/pro/ultra vs
 * flash/mini/nano), parameter counts, coder variants, family traits and description flags.
 */
function inferProfile(id, desc = "") {
  const t = tail(id);
  const toks = t.split(/[-_.:@\s/]+/).filter(Boolean);
  const has = (...w) => w.some((x) => toks.includes(x));
  const d = str(desc).toLowerCase();
  const family = familyOf(id);
  const sizeM = toks.map((x) => /^(\d+(?:\.\d+)?)b$/.exec(x)).find(Boolean);
  const size = sizeM ? parseFloat(sizeM[1]) : null;
  // host metadata in the description: "reasoning" and "thinking: low/medium/high/xhigh/max"
  const levels = /thinking\s*:\s*([a-z/ ,]+)/.exec(d);
  const thinking = levels ? THINKING.filter((l) => levels[1].split(/[\s/,]+/).includes(l)) : [];
  const deepThinker = thinking.includes("xhigh") || thinking.includes("max");

  let tier = "mid";
  if (has("nano", "lite", "tiny", "micro") || (size !== null && size <= 4)) tier = "tiny";
  else if (has("haiku", "flash", "mini", "small", "instant", "air", "fast") || (size !== null && size <= 40)) tier = "small";
  else if (
    has("opus", "ultra", "pro", "max", "large", "o1", "o3", "o4", "r1", "reasoner", "thinking", "k2") ||
    (size !== null && size >= 200) ||
    (family === "openai" && /^gpt-?5/.test(t))
  ) tier = "flagship";

  const p = { ...TIER_BASE[tier], vision: null, reasoningModel: false, unstable: false, thinking: [], tier, family };

  if (has("coder", "codestral", "devstral", "codex", "code")) {
    p.coding = clamp(p.coding + 2);
    p.writing = clamp(p.writing - 1);
  }
  if (family === "claude") { p.coding = clamp(p.coding + 1); p.context = 4; p.vision = true; }
  if (family === "gemini") { p.context = 5; p.vision = true; }
  if (family === "openai" && /^(gpt-?4o|gpt-?4\.1|gpt-?5|o3|o4)/.test(t)) p.vision = true;
  if (family === "openai" && /^gpt-?4\.1/.test(t)) p.context = 5;
  if (family === "kimi") p.context = 4;
  if (has("vl", "vision", "omni", "4o", "pixtral", "llava")) p.vision = true;
  if (has("1m", "2m")) p.context = 5;
  else if (has("128k", "200k", "256k")) p.context = Math.max(p.context, 4);

  if (has("reasoner", "r1", "thinking", "o1", "o3", "o4", "qwq") || /\breasoning\b/.test(d)) {
    p.reasoningModel = true;
    p.reasoning = clamp(p.reasoning + 1);
    if (has("reasoner", "r1", "thinking")) p.speed = clamp(p.speed - 1);
  }
  p.thinking = thinking;
  // a model the host lets think at xhigh/max reasons deeply, whatever its name says
  if (deepThinker) { p.reasoningModel = true; p.reasoning = clamp(p.reasoning + 1); }
  if (has("preview", "exp", "experimental", "beta", "free") || /\bfree\b|preview|rate.?limit/.test(d)) p.unstable = true;

  const nums = toks.filter((x) => /^\d/.test(x) && !/^\d+(\.\d+)?[bkm]$/.test(x)).map((x) => parseInt(x, 10));
  p.version = nums.length ? nums[0] + (nums[1] !== undefined ? Math.min(nums[1], 99) / (nums[1] < 10 ? 10 : 100) : 0) : 0;
  return p;
}

/** Profile with the user's overrides ({ glob: { trait: value } }, applied in order) on top. */
function profileOf(entry, overrides) {
  const p = inferProfile(entry.id, entry.desc);
  p.overridden = false;
  for (const [pattern, patch] of Object.entries(isObj(overrides) ? overrides : {})) {
    if (!isObj(patch) || !matchesAny(entry.id, [pattern])) continue;
    for (const k of TRAITS) if (typeof patch[k] === "number") p[k] = clamp(patch[k]);
    for (const k of ["vision", "reasoningModel", "unstable"]) if (typeof patch[k] === "boolean") p[k] = patch[k];
    if (Array.isArray(patch.thinking)) p.thinking = THINKING.filter((l) => patch.thinking.includes(l));
    p.overridden = true;
  }
  return p;
}

const profileLine = (id, p) =>
  `${id}: ${p.tier}${p.overridden ? "*" : ""} R${p.reasoning} C${p.coding} W${p.writing} X${p.context} S${p.speed} $${p.cost}` +
  `${p.vision === true ? " vision" : p.vision === false ? " no-vision" : ""}${p.reasoningModel ? " reasoning" : ""}${p.unstable ? " unstable" : ""}`;

// ---------- requirements and scoring ----------
function normalizeRequirements(req, where) {
  const warnings = [];
  const r = isObj(req) ? req : {};
  const out = {};
  for (const [k, allowed] of Object.entries(REQ_ENUMS)) {
    if (r[k] === undefined) continue;
    if (!allowed.includes(r[k])) fail(`${where}: requirements.${k} must be one of ${allowed.join(", ")}`);
    out[k] = r[k];
  }
  for (const k of ["vision", "reasoning"]) if (r[k] !== undefined) out[k] = r[k] === true;
  if (r.thinking !== undefined) {
    if (!THINKING.includes(r.thinking)) fail(`${where}: requirements.thinking must be one of ${THINKING.join(", ")}`);
    out.thinking = r.thinking;
  }
  out.differentFrom = typeof r.differentFrom === "string" ? [r.differentFrom] : strList(r.differentFrom);
  out.prefer = strList(r.prefer);
  out.avoid = strList(r.avoid);
  const unknown = Object.keys(r).filter((k) => !REQ_KEYS.includes(k));
  if (unknown.length) warnings.push(`${where}: ignored unknown requirement(s) ${unknown.join(", ")}`);
  return { req: out, warnings };
}

/** Trait weights of a task type adjusted by its requirements. */
function weightsFor(type, req) {
  const w = Object.fromEntries(TRAITS.map((k) => [k, TASK_TYPES[type].weights[k] || 0]));
  const q = { low: 0.6, normal: 1, high: 1.4, max: 2 }[req.quality || "normal"];
  for (const k of ["reasoning", "coding", "writing"]) w[k] *= q;
  if (req.quality === "low") w.cost += 2;
  if (req.speed === "high") w.speed += 4;
  if (req.speed === "low") w.speed = 0;
  if (req.budget === "low") w.cost += 5;
  if (req.budget === "high") w.cost = 0;
  if (req.context === "long") w.context += 3;
  if (req.context === "huge") w.context += 6;
  if (req.context === "short") w.context = Math.min(w.context, 1);
  return w;
}

function scoreProfile(p, w, req, id, avoidFamilies) {
  let sum = 0;
  let wsum = 0;
  for (const k of TRAITS) {
    sum += w[k] * p[k];
    wsum += w[k];
  }
  let s = wsum ? sum / wsum : 3;
  // traits saturate at 5: on quality-heavy tasks the stronger tier still wins a tie
  const qShare = wsum ? (w.reasoning + w.coding + w.writing) / wsum : 0;
  s += TIER_BONUS[p.tier] * qShare;
  const notes = [];
  if (p.unstable && req.budget !== "low") { s -= 0.75; notes.push("unstable/free tier"); }
  if (req.reasoning && p.reasoningModel) s += 0.5;
  if (req.vision && p.vision === true) s += 0.25;
  if (req.prefer.length && matchesAny(id, req.prefer)) { s += 1; notes.push("preferred"); }
  if (avoidFamilies.has(p.family)) { s -= 0.6; notes.push(`same family as ${[...avoidFamilies].join("/")}`); }
  s += Math.min(p.version || 0, 20) * 0.01; // newer generation breaks ties
  return { score: round(s), notes };
}

/**
 * Pick the suggested thinking level the model supports, closest to the wanted one.
 * `exclude` lists levels never to use (setting excludeThinking); they are skipped, the level goes down first.
 */
function thinkingFor(type, req, p, exclude = []) {
  let want = req.thinking;
  if (!want) {
    const i = THINKING.indexOf(TASK_TYPES[type].thinking);
    const bump = { low: -1, normal: 0, high: 1, max: 9 }[req.quality || "normal"];
    want = THINKING[Math.max(0, Math.min(THINKING.length - 1, i + bump))];
  }
  const ok = (l) => !exclude.includes(l);
  const allowed = THINKING.filter(ok);
  if (allowed.length && !ok(want)) {
    const down = allowed.filter((l) => THINKING.indexOf(l) < THINKING.indexOf(want));
    want = down.length ? down[down.length - 1] : allowed[0];
  }
  if (!p || !p.thinking.length) return p && p.reasoningModel ? want : null;
  const levels = p.thinking.filter(ok).length ? p.thinking.filter(ok) : p.thinking.slice(0, 1);
  const wi = THINKING.indexOf(want);
  const below = levels.filter((l) => THINKING.indexOf(l) <= wi);
  return below.length ? below[below.length - 1] : levels[0];
}

/**
 * Route one task. `ctx` = { entries, profiles, exclude, pins, chosen: Map(taskId -> model) }.
 * Returns { model, fallbacks, thinking, score, why, candidates, warnings }.
 */
function routeTask(task, ctx) {
  const { type } = task;
  const { req } = task;
  const warnings = [];
  if (!ctx.entries.length) {
    if (strList(ctx.pins[type]).length) warnings.push(`${task.id}: no delegation catalog, so the ${type} role model is ignored and the session model is used`);
    return { model: "inherit", fallbacks: [], thinking: thinkingFor(type, req, null, ctx.excludeThinking), score: null, why: "no delegation catalog: run on the session model", candidates: [], warnings };
  }
  let pool = ctx.entries.filter((e) => !matchesAny(e.id, ctx.exclude) && !matchesAny(e.id, req.avoid));
  if (!pool.length) {
    warnings.push(`${task.id}: every model is excluded or avoided; ignoring avoid patterns`);
    pool = ctx.entries.filter((e) => !matchesAny(e.id, ctx.exclude));
  }
  if (!pool.length) fail("every model of the catalog is excluded; remove an exclusion with superagent_config");
  const hard = [
    ["vision", req.vision, (p) => p.vision === true, (p) => p.vision !== false],
    ["context huge", req.context === "huge", (p) => p.context >= 4, null],
    ["reasoning", req.reasoning, (p) => p.reasoningModel || p.reasoning >= 5, null],
  ];
  for (const [name, on, strict, loose] of hard) {
    if (!on) continue;
    const s = pool.filter((e) => strict(ctx.profiles.get(e.id)));
    const l = loose ? pool.filter((e) => loose(ctx.profiles.get(e.id))) : [];
    if (s.length) pool = s;
    else if (l.length) { pool = l; warnings.push(`${task.id}: no model is known to support ${name}; using models not known to lack it`); }
    else warnings.push(`${task.id}: no model satisfies ${name}; requirement ignored`);
  }
  const avoidFamilies = new Set();
  for (const other of req.differentFrom) {
    const m = ctx.chosen.get(other);
    if (m && m !== "inherit") avoidFamilies.add((ctx.profiles.get(m) || inferProfile(m)).family);
    else if (!m) warnings.push(`${task.id}: differentFrom ${other} is not routed before this task; ignored`);
  }
  if (avoidFamilies.size) {
    const other = pool.filter((e) => !avoidFamilies.has(ctx.profiles.get(e.id).family));
    if (other.length) pool = other;
    else warnings.push(`${task.id}: no usable model outside the ${[...avoidFamilies].join("/")} family; differentFrom kept as a preference`);
  }
  const w = weightsFor(type, req);
  const ranked = pool
    .map((e) => ({ id: e.id, ...scoreProfile(ctx.profiles.get(e.id), w, req, e.id, avoidFamilies) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const pinned = strList(ctx.pins[type]);
  const pins = pinned.filter((id) => pool.some((e) => e.id === id));
  const lost = pinned.filter((id) => !pins.includes(id));
  if (lost.length) warnings.push(`${task.id}: role model(s) ${lost.join(", ")} for ${type} not usable here (not in the catalog, excluded, or filtered by the requirements)`);
  const primary = pins[0] || ranked[0].id;
  const chain = [primary];
  const add = (id) => { if (!chain.includes(id)) chain.push(id); };
  const sameModel = (id) => ranked.filter((r) => r.id !== id && tail(r.id) === tail(id)).map((r) => r.id);
  sameModel(primary).forEach(add);
  pins.slice(1).forEach(add);
  const pFam = ctx.profiles.get(primary).family;
  const primaryScore = (ranked.find((r) => r.id === primary) || ranked[0]).score;
  const otherFamily = ranked.find((r) => !chain.includes(r.id) && ctx.profiles.get(r.id).family !== pFam && r.score >= primaryScore - 1);
  let extra = 0;
  for (const r of [otherFamily, ...ranked].filter(Boolean)) {
    if (extra >= MAX_FALLBACKS) break;
    if (chain.includes(r.id)) continue;
    add(r.id);
    sameModel(r.id).forEach(add);
    extra++;
  }
  const p = ctx.profiles.get(primary);
  const top = ranked.find((r) => r.id === primary);
  const lead = Object.entries(w).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const why = pins.includes(primary)
    ? `pinned for ${type} in settings`
    : `best ${lead.join("+")} fit (score ${top.score}/5; ${p.tier} ${p.family}${top.notes.length ? "; " + top.notes.join(", ") : ""})`;
  return {
    model: primary,
    fallbacks: chain.slice(1),
    thinking: thinkingFor(type, req, p, ctx.excludeThinking),
    score: top ? top.score : null,
    why,
    candidates: ranked.slice(0, 5).map((r) => `${r.id} ${r.score}`),
    warnings,
  };
}

// ---------- configuration ----------
const ADMISSION_DEFAULTS = { listedUnaddressed: "inferred", unlistedAddressed: "ignore", unlistedUnaddressed: "ignore" };
const ADMISSION_OPTIONS = { listedUnaddressed: ["inferred", "ignore"], unlistedAddressed: ["explicit", "inferred", "ignore"], unlistedUnaddressed: ["inferred", "ignore"] };
const STRENGTH_RANK = { ignore: 0, inferred: 1, explicit: 2 };
const MODES = ["off", "observe", "auto"];
const DEFAULT_RULES = [
  {
    id: "copy",
    name: "Copy fixes",
    enabled: true,
    instruction: "A clear request to fix a typo, wording, punctuation or an existing translation. Keep the meaning, promises and business terms of the text unchanged.",
  },
  {
    id: "visual",
    name: "Visual fixes",
    enabled: true,
    instruction: "A clear request to fix local spacing, alignment, overflow or styling, where the wanted result is stated or an existing standard or earlier correct state shows it. Pointing at an element, or calling it odd, inconsistent or hard to read, does not state a result. Never choose visual style, hierarchy, rendering or interaction for the person, never redesign, and never change behaviour. A known spacing problem does not license nearby restyling; assess only a part that is clearly separate and settled. When direction or scope is open, only observe: no acknowledgement, no worker, no question.",
  },
];
const TEAM_KEYS = { communication: "communication", scope: "ticketScope", delivery: "delivery" };
const TEAM_TITLES = { communication: "Communication", scope: "Ticket scope", delivery: "Delivery requirements" };

function teamDefault(name) {
  try {
    return fs.readFileSync(path.join(__dirname, "prompts", "team", `${name}.md`), "utf8").trim();
  } catch {
    return "";
  }
}

/** Settings with defaults; a malformed value falls back to its default rather than failing a call. */
async function settings() {
  const s = (await pi.plugin.getSettings()) || {};
  const policy = isObj(s.policy) ? s.policy : {};
  const rules = Array.isArray(policy.rules) ? policy.rules.filter((r) => isObj(r) && RULE_ID_RE.test(str(r.id)) && str(r.instruction).trim()) : DEFAULT_RULES;
  const part = isObj(policy.sources) && isObj(policy.sources[SOURCE]) ? policy.sources[SOURCE] : {};
  const allowed = Array.isArray(part.allowed) ? part.allowed.filter((a) => isObj(a) && str(a.id).trim()) : [{ id: PERSON, name: "You" }];
  const row = isObj(part.admission) && isObj(part.admission[SOURCE]) ? part.admission[SOURCE] : {};
  const admission = {};
  for (const [cell, options] of Object.entries(ADMISSION_OPTIONS)) if (options.includes(row[cell])) admission[cell] = row[cell];
  const n = Number(s.maxWorkers);
  const t = Number(s.evalTimeoutSeconds);
  return {
    paused: s.paused === true,
    isolation: ISOLATION.includes(s.isolation) ? s.isolation : "auto",
    policy: {
      mode: MODES.includes(policy.mode) ? policy.mode : "observe",
      rules: rules.map((r) => ({ id: str(r.id), name: str(r.name) || str(r.id), enabled: r.enabled !== false, instruction: str(r.instruction).trim() })),
      sources: { [SOURCE]: { allowed: allowed.map((a) => ({ id: str(a.id).trim(), ...(a.name ? { name: str(a.name) } : {}) })), admission: { [SOURCE]: admission } } },
    },
    evalTimeoutSeconds: Number.isInteger(t) && t >= 30 && t <= 3600 ? t : DEFAULT_EVAL_TIMEOUT,
    maxWorkers: Number.isInteger(n) && n >= 1 && n <= MAX_WORKERS ? n : DEFAULT_WORKERS,
    proofRounds: Number.isInteger(s.proofRounds) && s.proofRounds >= 0 && s.proofRounds <= MAX_PROOF_ROUNDS ? s.proofRounds : DEFAULT_PROOF_ROUNDS,
    profiles: isObj(s.modelProfiles) ? s.modelProfiles : {},
    pins: isObj(s.roleModels) ? s.roleModels : {},
    exclude: strList(s.excludeModels),
    excludeThinking: Array.isArray(s.excludeThinking) ? THINKING.filter((l) => s.excludeThinking.includes(l)) : DEFAULT_EXCLUDE_THINKING,
    notes: strList(s.modelNotes),
    team: Object.fromEntries(Object.entries(TEAM_KEYS).map(([name, key]) => [name, str(s[key]).trim()])),
    promptRevision: Number.isInteger(s.promptRevision) ? s.promptRevision : 0,
  };
}
const teamText = (cfg, name) => cfg.team[name] || teamDefault(name);

/** The Policy version: rules, accept mode and the Source's part; models, slots and pause do not change it. */
function policyVersion(cfg) {
  return crypto.createHash("sha1").update(JSON.stringify({ rules: cfg.policy.rules, mode: cfg.policy.mode, sources: cfg.policy.sources })).digest("hex").slice(0, 12);
}
const enabledRules = (cfg) => cfg.policy.rules.filter((r) => r.enabled);
const sourcePart = (cfg) => cfg.policy.sources[SOURCE];
const isAllowed = (cfg, actor) => sourcePart(cfg).allowed.some((a) => a.id.toLowerCase() === str(actor && actor.id).toLowerCase());
const admissionOf = (cfg, cell) => sourcePart(cfg).admission[SOURCE][cell] || ADMISSION_DEFAULTS[cell];

// ---------- models: the user's own list ----------
/** The models the user made available to sub-agents, as router entries `{ id: provider/model, desc }`. */
async function loadCatalog() {
  let models;
  try {
    models = (await pi.models.list()) || [];
  } catch (e) {
    return { entries: [], note: `could not read your models (${e && e.message}); workers run on the session model` };
  }
  const listed = models.filter((m) => isObj(m) && m.availableForSubagents === true && str(m.key || (m.providerId && `${m.providerId}/${m.modelId}`)));
  const entries = parseCatalog(listed.map((m) => ({
    id: str(m.key) || `${m.providerId}/${m.modelId}`,
    description: [m.providerName, m.label, m.alias, m.supportsReasoning ? "reasoning" : "", Array.isArray(m.thinkingLevels) && m.thinkingLevels.length ? `thinking: ${m.thinkingLevels.join("/")}` : ""].filter(Boolean).join(", "),
  })));
  const note = entries.length ? null : models.length
    ? "none of your models is enabled for sub-agents (Settings > Models); workers run on the session model"
    : "no signed-in models found; workers run on the session model";
  return { entries, note };
}

function routingContext(entries, cfg) {
  const profiles = new Map(entries.map((e) => [e.id, profileOf(e, cfg.profiles)]));
  return { entries, profiles, exclude: cfg.exclude, excludeThinking: cfg.excludeThinking || DEFAULT_EXCLUDE_THINKING, pins: cfg.pins, chosen: new Map() };
}

// ---------- state (workspace, through pi.fs) ----------
const now = () => new Date().toISOString();
const ticketDir = (id) => `${ROOT_DIR}/tickets/${id}`;
const briefFile = (id, n) => `${ticketDir(id)}/turn-${n}.md`;
const reportFile = (id, n) => `${ticketDir(id)}/report-${n}.md`;
const quote = (text) => str(text).split("\n").map((l) => `> ${l}`).join("\n");

function emptyState() {
  return { schema: 1, seq: 0, triggers: {}, dispositions: {}, threads: {}, tickets: {}, decisions: [], outbox: [] };
}
async function loadState() {
  let text = null;
  try {
    text = await pi.fs.readText(STATE_FILE);
  } catch {
    return emptyState();
  }
  try {
    return { ...emptyState(), ...JSON.parse(text) };
  } catch {
    fail(`${STATE_FILE} is not valid JSON; fix or remove it`);
  }
}
async function saveState(state) {
  await pi.fs.writeText(STATE_FILE, JSON.stringify(state, null, 1));
}
const nextId = (state, prefix) => `${prefix}${++state.seq}`;

async function readOrNull(p) {
  try {
    return await pi.fs.readText(p);
  } catch {
    return null;
  }
}

/** Words as a reader counts them; each CJK character counts as one. */
function wordCount(text) {
  const cjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
  const s = str(text);
  return (s.match(cjk) || []).length + (s.replace(cjk, " ").match(/\S+/g) || []).length;
}
function slug(text) {
  const s = str(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return s || "ticket";
}

// ---------- domain queries ----------
const liveTicket = (t) => !t.ended;
const latestAssignment = (t) => t.assignments[t.assignments.length - 1];
const latestReport = (t) => {
  for (let i = t.assignments.length - 1; i >= 0; i--) if (t.assignments[i].report) return t.assignments[i].report;
  return undefined;
};
const activeTurn = (a) => a && a.turns.find((x) => x.state !== "ended");
const ticketTurns = (t) => t.assignments.flatMap((a) => a.turns);
/** The tickets of `after` that have not ended yet: until they end, this ticket does not start. */
const afterOpen = (state, t) => (t.after || []).filter((id) => state.tickets[id] && liveTicket(state.tickets[id]));

/** The latest assignment reported blocked or failed and no person's message reached the ticket since. */
function waitsForPerson(t) {
  const r = latestAssignment(t) && latestAssignment(t).report;
  if (!r || (r.state !== "blocked" && r.state !== "failed")) return false;
  // a worker turn reads only what its brief carried: a message it never saw lifts the hold
  return !t.inputs.some((i) => i.kind === "trigger" && i.human && !i.context && (i.at > r.at || !i.turn || (r.turn && i.turn > r.turn)));
}

/** Stages, first matching row wins. The prototype's delivery row cannot occur: a brief is a file write. */
function ticketStage(t) {
  if (t.ended) return { stage: "ended", outcome: t.ended.outcome };
  if (t.attention) return { stage: "person", action: "answer" };
  const a = latestAssignment(t);
  const report = a && a.report && a.report.state;
  const live = a && activeTurn(a);
  if (t.merge && t.merge.state !== "unmerged" && !live) return { stage: "working", action: "merge" };
  if (t.hold && !live) return { stage: "working", action: "proof" };
  if (report === "ready" && !live) return { stage: "person", action: "review" };
  if ((report === "blocked" || report === "failed") && waitsForPerson(t)) return { stage: "person", action: report };
  if (!a || a.state === "pending") return { stage: "working", action: "queued" };
  const turn = activeTurn(a);
  if (turn && turn.state === "pending") return { stage: "working", action: "queued" };
  if (!turn && (report === "waiting" || a.state === "ended" || report)) return { stage: "idle" };
  return { stage: "working" };
}
const stageLabel = (t) => {
  const s = ticketStage(t);
  return s.stage === "ended" ? `ended/${s.outcome}` : s.action ? `${s.stage}/${s.action}` : s.stage;
};

/** Tickets of a thread that take part in it (not followed only for context). */
const participating = (state, thread) => thread.subscriptions.some((id) => !(thread.context || []).includes(id) && state.tickets[id]);

/** The tickets whose worker decides a person's message: reached on their own threads, not handed back, still able to decide. */
function followupOwners(state, trigger) {
  const d = state.dispositions[trigger.id];
  if (!d || d.requeued) return [];
  const back = new Set((d.handbacks || []).map((h) => h.ticketId));
  const thread = state.threads[trigger.threads[0]];
  if (thread && thread.evaluating && thread.evaluating.triggerIds.includes(trigger.id)) return [];
  return d.fanout.filter((id) => {
    if (back.has(id) || (d.context || []).includes(id)) return false;
    const t = state.tickets[id];
    if (!t) return false;
    if (liveTicket(t)) return true;
    return t.ended.by !== "human" && t.inputs.some((i) => i.kind === "trigger" && i.triggerId === trigger.id && t.undelivered.includes(i.id));
  });
}

/** Whether a decision settled what a message asks: a stop, an unavailable judgement or routing it to a ticket did not. */
const settled = (decision) => !!decision && !["stop", "unavailable"].includes(decision.kind)
  && !decision.reason.some((r) => ["stopNotExplicit", "stopUnknown", "routed"].includes(r.code));

// ---------- gate, mandate revalidation, policy effects ----------
/** Who may originate work, and with what strength. The chat Source has one sender, the person, and no bots. */
function gate(state, cfg, trigger, thread) {
  const allowed = isAllowed(cfg, trigger.actor);
  const mode = cfg.policy.mode;
  const recorded = { source: SOURCE, ...(allowed ? { sender: trigger.actor.id } : {}) };
  if (allowed && trigger.addressed) return { admissible: true, strength: "explicit", basis: { ...recorded, via: "addressed", addressed: trigger.addressed } };
  const cell = allowed ? "listedUnaddressed" : trigger.addressed ? "unlistedAddressed" : "unlistedUnaddressed";
  const admission = admissionOf(cfg, cell);
  const basis = { ...recorded, via: "admission", cell, ...(trigger.addressed ? { addressed: trigger.addressed } : {}) };
  if (admission === "explicit") return { admissible: true, strength: "explicit", basis };
  if (!(trigger.addressed === "direct" && !allowed) && (allowed || mode !== "off") && participating(state, thread)) {
    return { admissible: true, strength: allowed ? "explicit" : "inferred", basis: { ...recorded, via: "followup" } };
  }
  if (admission === "inferred" && mode !== "off") return { admissible: true, strength: "inferred", basis: { ...basis, observation: { mode } } };
  return { admissible: false, reason: !allowed ? "not_a_member" : admission === "ignore" ? "admission_ignored" : "no_mention" };
}

/** Whether a Mandate still holds under today's Policy; checked before an ended ticket resumes. */
function revalidate(cfg, mandate) {
  const { basis } = mandate;
  const mode = cfg.policy.mode;
  const rulesOn = (rules) => (rules || []).every((id) => cfg.policy.rules.some((r) => r.enabled && r.id === id));
  const listed = isAllowed(cfg, mandate.actor);
  if (basis.via === "followup") return mandate.strength === "explicit" || (mode === "auto" && rulesOn(basis.rules));
  if (basis.via === "admission") {
    if (basis.cell === "unlistedAddressed" && listed) return true;
    const cell = basis.cell === "unlistedUnaddressed" && listed ? "listedUnaddressed" : basis.cell;
    if (cell === "listedUnaddressed" && !listed) return false;
    if (STRENGTH_RANK[admissionOf(cfg, cell)] < STRENGTH_RANK[mandate.strength]) return false;
    if (mandate.strength === "explicit") return true;
  } else if (!listed) return false;
  if (basis.via === "admission" && basis.observation) return mode === "auto" && rulesOn(basis.rules);
  return true;
}

/** How a settings change bears on each live ticket: its rules changed or went away, proactive work stopped, its sender lost access. */
function policyEffects(state, before, after) {
  const effects = new Map();
  for (const t of Object.values(state.tickets)) {
    if (!liveTicket(t)) continue;
    const rules = (t.mandate.basis.rules || []).flatMap((id) => {
      const was = before.policy.rules.find((r) => r.id === id);
      const is = after.policy.rules.find((r) => r.id === id);
      if (!is || !is.enabled) return was && was.enabled ? [{ id, name: was.name, change: "disabled" }] : [];
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: "changed", instruction: is.instruction }];
    });
    const effect = rules.length ? { rules } : {};
    if (revalidate(before, t.mandate) && !revalidate(after, t.mandate)) {
      const asBefore = { ...after, policy: { ...after.policy, mode: before.policy.mode, rules: before.policy.rules } };
      if (!revalidate(asBefore, t.mandate)) Object.assign(effect, { requesterAllowed: false, requester: t.mandate.actor });
      else if (t.mandate.strength === "inferred" && before.policy.mode === "auto" && after.policy.mode !== "auto") effect.proactive = false;
    }
    if (Object.keys(effect).length) effects.set(t.id, effect);
  }
  return effects;
}

// ---------- Eval ----------
/** Start the next Eval of a thread from its queued triggers, unless one runs. Returns the candidate card, or null. */
function startEval(state, cfg, thread, out) {
  if (thread.evaluating || !thread.pending.length || cfg.paused) return null;
  const batch = thread.pending.splice(0);
  let best = null;
  for (const id of batch) {
    const g = gate(state, cfg, state.triggers[id], thread);
    const d = state.dispositions[id];
    if (!g.admissible) {
      d.filtered = g.reason;
      continue;
    }
    delete d.filtered;
    if (!best || STRENGTH_RANK[g.strength] > STRENGTH_RANK[best.g.strength]) best = { id, g };
  }
  if (!best) {
    out.filtered.push(...batch.map((id) => ({ trigger_id: id, reason: state.dispositions[id].filtered })));
    return null;
  }
  const admitted = batch.filter((id) => !state.dispositions[id].filtered);
  const ev = {
    id: nextId(state, "e"), threadKey: thread.key, triggerIds: admitted, primary: best.id, strength: best.g.strength,
    actor: state.triggers[best.id].actor, basis: best.g.basis, policyVersion: policyVersion(cfg),
    startedAt: now(), deadline: new Date(Date.now() + cfg.evalTimeoutSeconds * 1000).toISOString(),
  };
  thread.evaluating = ev;
  for (const id of admitted) state.dispositions[id].evalId = ev.id;
  const card = candidateCard(state, cfg, thread, ev);
  out.candidates.push(card);
  return card;
}

function candidateCard(state, cfg, thread, ev) {
  const triggers = ev.triggerIds.map((id) => state.triggers[id]);
  const tickets = thread.subscriptions.map((id) => state.tickets[id]).filter(Boolean)
    .sort((a, b) => Number(!liveTicket(a)) - Number(!liveTicket(b)))
    .map((t) => ({ ticket: t.id, title: t.title, stage: stageLabel(t), stopped_by_person: !!(t.ended && t.ended.by === "human") }));
  const text = triggers.map((t) => t.text).join("\n");
  const referenced = Object.keys(state.tickets).filter((id) => new RegExp(`(^|[^a-z0-9-])${id.replace(/[-]/g, "\\-")}($|[^a-z0-9-])`, "i").test(text));
  const handedBack = triggers.flatMap((t) => (state.dispositions[t.id].handbacks || []).map((h) => ({ trigger_id: t.id, ticket: h.ticketId, reason: h.reason })));
  const card = {
    trigger_id: ev.primary, thread: thread.key, strength: ev.strength, via: ev.basis.via,
    batch: triggers.map((t) => ({ trigger_id: t.id, at: t.at, addressed: !!t.addressed, text: t.text })),
    thread_tickets: tickets, referenced_tickets: referenced, handed_back: handedBack,
    decide_with: ev.strength === "explicit" ? "superagent_route" : "superagent_eval_decide (or superagent_route ignore when the card clearly touches no enabled rule)",
  };
  if (ev.strength === "inferred") {
    card.mode = cfg.policy.mode;
    card.rules = enabledRules(cfg).map((r) => ({ id: r.id, name: r.name, instruction: r.instruction }));
  }
  return card;
}

function recordDecision(state, cfg, thread, ev, fields, out) {
  const decision = {
    id: nextId(state, "d"), evalId: ev.id, threadKey: thread.key, triggerIds: ev.triggerIds, policyVersion: ev.policyVersion,
    at: now(), strength: ev.strength, ...fields,
  };
  state.decisions.push(decision);
  for (const id of ev.triggerIds) state.dispositions[id].decisionId = decision.id;
  thread.evaluating = null;
  thread.expired = 0;
  startEval(state, cfg, thread, out);
  return decision;
}

/** Expired Evals queue their triggers again; the third expiry in a row records unavailable. */
function expireEvals(state, cfg, out) {
  const t = now();
  for (const thread of Object.values(state.threads)) {
    const ev = thread.evaluating;
    if (!ev || ev.deadline > t) continue;
    thread.expired = (thread.expired || 0) + 1;
    if (thread.expired >= 3) {
      recordDecision(state, cfg, thread, ev, { kind: "unavailable", reason: [{ code: "expired" }] }, out);
    } else {
      thread.evaluating = null;
      thread.pending.unshift(...ev.triggerIds);
      startEval(state, cfg, thread, out);
    }
  }
}

/** A Policy change discards running Evals against the old version and queues their triggers under the new one. */
function requeueOutdated(state, cfg, out) {
  const version = policyVersion(cfg);
  for (const thread of Object.values(state.threads)) {
    const ev = thread.evaluating;
    if (!ev || ev.policyVersion === version) continue;
    recordDecision(state, cfg, thread, ev, { kind: "unavailable", reason: [{ code: "policyChanged" }] }, out);
    thread.pending.unshift(...ev.triggerIds.filter((id) => !thread.pending.includes(id)));
    startEval(state, cfg, thread, out);
  }
}

/** Send a trigger to Eval on its thread (after a handback, a release, or a requeue). */
function toEval(state, cfg, trigger, out) {
  const thread = state.threads[trigger.threads[0]];
  if (!thread.pending.includes(trigger.id) && !(thread.evaluating && thread.evaluating.triggerIds.includes(trigger.id))) thread.pending.push(trigger.id);
  startEval(state, cfg, thread, out);
}

// ---------- tickets, inputs, assignments, turns ----------
function addInput(state, t, input) {
  const i = { id: nextId(state, "i"), at: now(), ...input };
  t.inputs.push(i);
  t.undelivered.push(i.id);
  t.updatedAt = now();
  return i;
}

/** A person's message reached the ticket and no worker has read it yet. */
function hasHumanUndelivered(t) {
  return t.undelivered.some((id) => {
    const i = t.inputs.find((x) => x.id === id);
    return i && i.kind === "trigger" && i.human && !i.context;
  });
}

/** Schedule a turn for what waits on the ticket. A held ticket (blocked or failed) wakes only for a person's message. */
function wake(state, t, { priority = false, kind = "work" } = {}) {
  if (!liveTicket(t)) return;
  if (kind === "work" && !t.undelivered.length && t.assignments.length) return;
  if (kind === "work" && waitsForPerson(t)) return;
  if (t.hold) {
    // ready work that waits for its proof wakes for a person, or for a fix the proof asks for
    if (kind === "work" && !hasHumanUndelivered(t)) return;
    delete t.hold;
  }
  if (t.merge && t.merge.state !== "unmerged") {
    // a branch waiting for its merge wakes only for a person; a queued branch leaves the queue, a merging one waits for the merge
    if (kind === "work" && !hasHumanUndelivered(t)) return;
    if (t.merge.state === "queued") delete t.merge;
  } else if (t.merge) delete t.merge;
  let a = latestAssignment(t);
  if (!a || a.state === "ended") {
    a = { id: nextId(state, "a"), state: "pending", model: t.model, createdAt: now(), turns: [] };
    t.assignments.push(a);
  }
  if (activeTurn(a)) return;
  const n = ticketTurns(t).length + 1;
  a.turns.push({ n, kind, priority, state: "pending", createdAt: now(), seq: nextSeq(), attempts: 0, inputs: [], brief: briefFile(t.id, n), report: reportFile(t.id, n) });
}

function endTicket(state, cfg, t, { by, outcome, reason }, out) {
  t.ended = { at: now(), by, outcome, ...(reason ? { reason } : {}) };
  t.attention = undefined;
  if (t.type === "merge" && outcome !== "completed" && outcome !== "dropped") {
    // a merge that did not finish leaves its branches ready but not landed: a person decides, `merge` queues them again
    for (const id of t.merges || []) {
      const s = state.tickets[id];
      if (s && s.merge && s.merge.by === t.id) s.merge = { state: "unmerged", at: now() };
    }
  } else if (t.merge && t.merge.state === "queued") delete t.merge;
  for (const a of t.assignments) {
    if (a.state === "ended") continue;
    for (const turn of a.turns) {
      if (turn.state === "running") out.stopAgents.push(`${t.id}#${turn.n}`);
      if (turn.state !== "ended") Object.assign(turn, { state: "ended", endedAt: now(), outcome: "cancelled" });
    }
    Object.assign(a, { state: "ended", endedAt: now(), endedReason: outcome });
  }
  // release what the worker never read, did not take up and did not hand back: each goes to Eval once no other ticket owns it
  const released = t.inputs.filter((i) => t.undelivered.includes(i.id) && i.kind === "trigger" && i.human && !i.context);
  t.undelivered = [];
  for (const i of released) {
    const d = state.dispositions[i.triggerId];
    if (!d || d.acked.includes(t.id) || (d.handbacks || []).some((h) => h.ticketId === t.id)) continue;
    const decision = d.decisionId && state.decisions.find((x) => x.id === d.decisionId);
    // a stopped ticket does not send its own stop message to Eval again, unless another ticket handed it back
    if (decision && decision.kind === "stop" && decision.ticketId === t.id && !(d.handbacks || []).length) continue;
    if (settled(decision)) continue;
    d.fanout = d.fanout.filter((id) => id !== t.id);
    if (!followupOwners(state, state.triggers[i.triggerId]).length) toEval(state, cfg, state.triggers[i.triggerId], out);
  }
  t.updatedAt = now();
}

// ---------- isolation: parallel writers in git worktrees, merged by a merge ticket ----------
/** The git repository folder of a ticket, relative to the workspace root: "" is the workspace root itself. */
const repoOf = (t) => (t && typeof t.repo === "string" ? t.repo : "");

/** Check the optional `repo` of an accept: a folder relative to the workspace root, inside it. */
function normalizeRepo(raw, where) {
  if (raw === undefined || raw === null) return "";
  const v = str(raw).trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!v || v === ".") return "";
  if (v.startsWith("/") || /^[a-z]:/i.test(v) || v.split("/").some((p) => p === ".." || p === "." || !p)) {
    fail(`${where}repo must be a folder relative to the workspace root, inside it (for example neural-radar), not ${JSON.stringify(raw)}`);
  }
  return v;
}

/** What is known about git in a ticket's repository folder: "git", "none" or undefined (not known yet). */
function vcsOf(state, repo) {
  if (!repo) return state.vcs;
  return (state.repos || {})[repo];
}
function setVcs(state, repo, value) {
  if (!repo) state.vcs = value;
  else (state.repos ||= {})[repo] = value;
}

/**
 * Look for git in the folder itself, so writers need not wait for a worker to confirm it: a `.git` folder with a
 * HEAD file, or a `.git` file that points at the git dir (a worktree or submodule). A found repository wins over
 * an earlier "none". Nothing found leaves the state as it is: the folder may sit inside a repository above it.
 */
async function probeGit(state, repo) {
  if (vcsOf(state, repo) === "git") return;
  const at = (p) => (repo ? `${repo}/${p}` : p);
  let found = false;
  try {
    found = /^(ref:|[0-9a-f]{40})/.test(str(await pi.fs.readText(at(".git/HEAD"))).trim());
  } catch {}
  if (!found) {
    try {
      found = /^gitdir:/.test(str(await pi.fs.readText(at(".git"))).trim());
    } catch {}
  }
  if (found) setVcs(state, repo, "git");
}

/** Worktrees may run side by side once git is found in the ticket's repository, or when the person says so. */
const parallelWriters = (cfg, state, repo = "") => cfg.isolation === "worktree" || (cfg.isolation === "auto" && vcsOf(state, repo) === "git");

/** Fix where a writer ticket works, at its first launch: its own worktree and branch, or the shared checkout. */
function ensureIsolation(state, cfg, t) {
  if (t.isolation || !writes(t) || t.type === "merge") return;
  const repo = repoOf(t);
  const wt = `${WORKTREE_DIR}/${t.id}`;
  t.isolation = cfg.isolation === "serial" || vcsOf(state, repo) === "none"
    ? { mode: "shared", ...(repo ? { repo } : {}) }
    : { mode: "worktree", branch: `superagent/${t.id}`, path: repo ? `${repo}/${wt}` : wt, base: `refs/superagent/base/${t.id}`, ...(repo ? { repo, wt } : {}) };
}

/**
 * A turn that may not overlap another such turn in the same folder: a merge or a writer in the shared checkout,
 * which both change the person's checkout, and a worktree writer while nobody knows yet whether its folder is a
 * git repository. Writers in different project folders do not collide.
 */
const exclusive = (cfg, state, t) => t.type === "merge" || (writes(t) && (!t.isolation || t.isolation.mode !== "worktree" || !parallelWriters(cfg, state, repoOf(t))));

/** Two folders overlap when they are the same or one holds the other; the workspace root holds every folder. */
const overlaps = (a, b) => a === b || !a || !b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

// ---------- model limits: shared by every ticket ----------
/** Limits apply per provider account: the part of a model key before the first `/`. */
const accountOf = (model) => str(model).split("/")[0];

/** Remember that an account hit a limit, so no ticket starts on it again until the cooldown ends. */
function coolAccount(state, model, reason) {
  if (!model || model === "inherit") return;
  (state.cooldown ||= {})[accountOf(model)] = { model, until: new Date(Date.now() + LIMIT_COOLDOWN_MS).toISOString(), reason: str(reason).slice(0, 200), at: now() };
}

/** Whether a model's account is in its cooldown; an ended cooldown is removed. */
function cooling(state, model) {
  const c = (state.cooldown || {})[accountOf(model)];
  if (!c) return false;
  if (Date.parse(c.until) > Date.now()) return true;
  delete state.cooldown[accountOf(model)];
  return false;
}

/** The ticket's next model that is not cooling: another account first, then any. */
function healthyModel(state, t, from) {
  const rest = (t.chain || []).filter((m) => m && m !== "inherit" && m !== from && !cooling(state, m));
  return rest.find((m) => accountOf(m) !== accountOf(from)) || rest[0] || null;
}

/** Cool every account the host reported as limited in a sub-agent result (`Model … failed (…)` lines). */
function learnLimits(state, text) {
  const hit = [];
  for (const m of str(text).matchAll(MODEL_FAILED)) {
    if (m[2] === "PROVIDER_RATE_LIMITED" || ACCOUNT_LIMIT.test(`${m[2]} ${m[3]}`)) {
      coolAccount(state, m[1], `${m[2]}: ${m[3]}`);
      hit.push(m[1]);
    }
  }
  return hit;
}

/**
 * Start one merge ticket per repository for the branches that wait, unless a merge is open there. A branch waits
 * for its sibling tickets in the same repository (the other parts of the same message) while they still work, so
 * a split request lands together.
 */
async function scheduleMerges(state, cfg, out) {
  if (cfg.paused) return;
  const tickets = Object.values(state.tickets);
  const queued = tickets.filter((t) => liveTicket(t) && t.merge && t.merge.state === "queued");
  const repos = [...new Set(queued.map(repoOf))];
  for (const repo of repos) {
    if (tickets.some((t) => t.type === "merge" && liveTicket(t) && repoOf(t) === repo)) continue;
    const ready = queued.filter((t) => repoOf(t) === repo && !(t.siblings || []).some((id) => {
      const s = state.tickets[id];
      // a sibling that waits for `after` tickets cannot get ready before they end: waiting for it would never end
      return s && repoOf(s) === repo && liveTicket(s) && writes(s) && !s.merge && !afterOpen(state, s).length && ticketStage(s).stage === "working";
    }));
    if (!ready.length) continue;
    const catalog = await loadCatalog();
    const id = uniqueTicketId(state, "merge");
    const ctx = routingContext(catalog.entries, cfg);
    const { req } = normalizeRequirements({}, "merge");
    const route = routeTask({ id, type: "merge", req }, ctx);
    out.warnings.push(...route.warnings);
    const ids = ready.map((t) => t.id);
    const first = ready[0];
    // its own thread: the person answers a merge question there
    const key = `${SOURCE}:${id}`;
    state.threads[key] = { key, createdAt: now(), subscriptions: [id], context: [], correlated: [], pending: [], evaluating: null, expired: 0 };
    const t = {
      id, title: `Merge ${ids.join(", ")}`, type: "merge", decisionId: null,
      mandate: { strength: "explicit", policyVersion: policyVersion(cfg), basis: { via: "merge", tickets: ids }, actor: first.mandate.actor, scope: `land the ready branches of ${ids.join(", ")} in the person's checkout${repo ? ` of ${repo}` : ""}` },
      channels: [key], attention: undefined, assignments: [], inputs: [], undelivered: [], answers: [], createdAt: now(), updatedAt: now(),
      origin: { triggerId: first.origin.triggerId, triggerIds: [] }, note: "", req, merges: ids, ...(repo ? { repo } : {}),
      model: route.model, chain: [route.model, ...route.fallbacks], why: route.why, thinking: route.thinking,
      thinkingByModel: Object.fromEntries([route.model, ...route.fallbacks].map((m) => [m, ctx.profiles.has(m) ? thinkingFor("merge", req, ctx.profiles.get(m), ctx.excludeThinking) : route.thinking])),
    };
    state.tickets[id] = t;
    for (const s of ready) s.merge = { state: "merging", by: id, at: now() };
    wake(state, t);
  }
}

/** A merge reported ready or dropped: its branches are landed, so their tickets complete (or first read what the person wrote meanwhile). */
function finishMerge(state, cfg, t, rep, out) {
  const at = now();
  const merged = [];
  for (const id of t.merges || []) {
    const s = state.tickets[id];
    if (!s || !s.merge || s.merge.by !== t.id) continue;
    delete s.merge;
    s.merged = { by: t.id, at };
    merged.push({ ticket: s.id, title: s.title, summary: (latestReport(s) || {}).summary || "" });
    if (!liveTicket(s)) continue;
    if (hasHumanUndelivered(s)) wake(state, s, { kind: "recheck", priority: true });
    else endTicket(state, cfg, s, { by: "executor", outcome: "completed" }, out);
  }
  endTicket(state, cfg, t, { by: "executor", outcome: rep.state === "ready" ? "completed" : "dropped" }, out);
  return merged;
}

// ---------- quality checks: acceptance tests written in parallel, a proof, and fixes until it passes ----------
/**
 * A check group: the writer tickets of one request that are proved together, so the proof also sees whether
 * the parts fit. `spec` writes the acceptance checklist and tests from the request while they work; once all
 * of them are ready, `proof` runs the tests and checks the fit, and sends defects back until the work passes
 * or `proofRounds` runs are used up. Only then do the branches go to the merge.
 */
const checkOf = (state, t) => (t && t.check && state.checks ? state.checks[t.check] : null);

/** The check level of a new ticket: the one asked for, else the type's default; none when checks are off. */
function checkLevel(cfg, type, raw, where) {
  if (!writes({ type }) || TASK_TYPES[type].internal || cfg.proofRounds === 0) return "none";
  if (raw === undefined || raw === null || raw === "") return DEFAULT_CHECK[type] || "none";
  if (!CHECK_LEVELS.includes(raw)) fail(`${where}check must be one of ${CHECK_LEVELS.join(", ")}`);
  return raw;
}

/** A ticket the plugin starts for a check group: its own thread, the request and mandate of the group's first ticket. */
function internalTicket(state, ctx, { id, type, title, scope, req, from, repo, out }) {
  const route = routeTask({ id, type, req }, ctx);
  ctx.chosen.set(id, route.model);
  out.warnings.push(...route.warnings);
  const key = `${SOURCE}:${id}`;
  state.threads[key] = { key, createdAt: now(), subscriptions: [id], context: [], correlated: [], pending: [], evaluating: null, expired: 0 };
  // the person's later messages on the request reach it as context: a changed requirement changes the checks too
  for (const k of from.channels) {
    const th = state.threads[k];
    if (th && !th.subscriptions.includes(id)) {
      th.subscriptions.push(id);
      (th.context ||= []).push(id);
    }
  }
  const t = {
    id, title: title.slice(0, 200), type, decisionId: from.decisionId, mandate: { ...from.mandate, scope },
    channels: [key], attention: undefined, assignments: [], inputs: [], undelivered: [], answers: [], createdAt: now(), updatedAt: now(),
    origin: { triggerId: from.origin.triggerId, triggerIds: [] }, note: from.note || "", req, ...(repo ? { repo } : {}),
    model: route.model, chain: [route.model, ...route.fallbacks], why: route.why, thinking: route.thinking,
    thinkingByModel: Object.fromEntries([route.model, ...route.fallbacks].map((m) => [m, ctx.profiles.has(m) ? thinkingFor(type, req, ctx.profiles.get(m), ctx.excludeThinking) : route.thinking])),
  };
  state.tickets[id] = t;
  return t;
}

/** Start a check group for writer tickets; `full` also starts the test worker now, in parallel with them. */
function createCheckGroup(state, cfg, ctx, members, level, out) {
  if (!members.length || level === "none") return null;
  state.checks ||= {};
  const id = uniqueTicketId(state, `check-${members[0].id}`, new Set(Object.keys(state.checks)));
  const g = { id, members: members.map((m) => m.id), level, spec: null, proof: null, runs: 0, state: "building", createdAt: now() };
  state.checks[id] = g;
  for (const m of members) m.check = id;
  if (level === "full") {
    const sid = uniqueTicketId(state, `${members[0].id}-spec`);
    const { req } = normalizeRequirements({ budget: "low" }, "spec");
    const s = internalTicket(state, ctx, {
      id: sid, type: "spec", title: `Acceptance tests: ${members.map((m) => m.title).join("; ")}`,
      scope: `write the acceptance checklist and tests for: ${members.map((m) => m.mandate.scope).join("; ")}`,
      req, from: members[0], repo: repoOf(members[0]), out,
    });
    s.check = id;
    g.spec = sid;
    wake(state, s);
  }
  return g;
}

/** Hand ready work on: to the merge queue when it sits on a branch, else it is done. */
function releaseChecked(state, cfg, t, out) {
  delete t.hold;
  if (!liveTicket(t)) return false;
  if (t.isolation && t.isolation.mode === "worktree") {
    t.merge = { state: "queued", at: now() };
    return true;
  }
  endTicket(state, cfg, t, { by: "executor", outcome: "completed" }, out);
  return false;
}

/** Run the proof of every group whose work is all ready; close groups whose tickets all ended. */
async function scheduleProofs(state, cfg, out) {
  if (cfg.paused || !state.checks) return;
  let catalog = null;
  for (const g of Object.values(state.checks)) {
    if (g.state === "passed" || g.state === "closed" || g.state === "escalated") continue;
    const members = g.members.map((id) => state.tickets[id]).filter(Boolean);
    const live = members.filter(liveTicket);
    const spec = g.spec ? state.tickets[g.spec] : null;
    const proof = g.proof ? state.tickets[g.proof] : null;
    if (!live.length) {
      // nothing left to prove: its tickets were stopped, dropped or had no change
      for (const x of [spec, proof]) if (x && liveTicket(x)) endTicket(state, cfg, x, { by: "executor", outcome: "dropped", reason: "nothing left to check" }, out);
      g.state = "closed";
      continue;
    }
    if (g.state === "proving") {
      // a stopped or ended proof leaves the work unproved: the person decides
      if (!proof || !liveTicket(proof)) escalate(state, g, out);
      continue;
    }
    const held = (x) => x.hold && x.hold.state === "proof";
    if (!live.every(held)) continue;
    if (spec && liveTicket(spec) && !held(spec)) continue;
    g.runs++;
    g.state = "proving";
    for (const x of [...live, spec]) if (x && x.hold) x.hold.state = "proving";
    if (proof && liveTicket(proof)) {
      addInput(state, proof, { kind: "proof-round", text: `Round ${g.runs}: the workers fixed what the earlier round found, or ruled on it. Check everything again: the branches below hold their latest work.` });
      wake(state, proof);
      continue;
    }
    catalog ||= await loadCatalog();
    const ctx = routingContext(catalog.entries, cfg);
    for (const x of Object.values(state.tickets)) ctx.chosen.set(x.id, x.model);
    // another model family than the workers it checks, so it does not share their blind spots
    const { req } = normalizeRequirements({ differentFrom: live.map((m) => m.id) }, "proof");
    const p = internalTicket(state, ctx, {
      id: uniqueTicketId(state, `${live[0].id}-proof`), type: "proof", title: `Proof: ${live.map((m) => m.title).join("; ")}`,
      scope: `check that the work of ${live.map((m) => m.id).join(", ")} passes its acceptance tests and fits the request and the codebase`,
      req, from: live[0], repo: repoOf(live[0]), out,
    });
    p.check = g.id;
    g.proof = p.id;
    wake(state, p);
  }
}

/** Proof runs used up, or the proof stopped: branches stay unmerged and the work waits for the person. */
function escalate(state, g, out) {
  g.state = "escalated";
  for (const id of [...g.members, g.spec].filter(Boolean)) {
    const t = state.tickets[id];
    if (!t || !t.hold) continue;
    delete t.hold;
    if (liveTicket(t) && t.isolation && t.isolation.mode === "worktree") t.merge = { state: "unmerged", at: now() };
  }
  out.warnings.push(`${g.id}: the work was not proved; its branches stay unmerged until the person decides (superagent_ticket merge, or retry)`);
}

/** A proof reported ready: pass sends the work to the merge, fail sends each defect back to its worker. */
function finishProof(state, cfg, p, rep, out) {
  const g = checkOf(state, p);
  if (!g) {
    endTicket(state, cfg, p, { by: "executor", outcome: "completed" }, out);
    return { handoff: { kind: "none" } };
  }
  const members = g.members.map((id) => state.tickets[id]).filter((t) => t && liveTicket(t));
  const spec = g.spec ? state.tickets[g.spec] : null;
  const held = [...members, spec].filter((t) => t && liveTicket(t) && t.hold);
  const pass = rep.verdict === "pass" || (rep.verdict !== "fail" && !rep.bugs.length && !rep.spec_bugs);
  if (pass) {
    g.state = "passed";
    let merging = false;
    for (const t of held) merging = releaseChecked(state, cfg, t, out) || merging;
    endTicket(state, cfg, p, { by: "executor", outcome: "completed" }, out);
    return merging
      ? { handoff: { kind: "none" }, note: `proof passed (round ${g.runs}): the branches are queued for the merge worker; the result goes to the person once they are landed` }
      : { handoff: { kind: "result", summary: rep.summary, purpose: "result" }, note: `proof passed (round ${g.runs})` };
  }
  if (g.runs >= cfg.proofRounds) {
    escalate(state, g, out);
    endTicket(state, cfg, p, { by: "executor", outcome: "failed", reason: `still failing after ${g.runs} proof rounds` }, out);
    return { handoff: { kind: "blocker", summary: `The work still fails its proof after ${g.runs} rounds: ${rep.summary}`, note: `its branches stay unmerged. Tell the person the main defect (report ${(ticketTurns(p).slice(-1)[0] || {}).report}), and offer to merge anyway (superagent_ticket merge) or to retry` }, note: "proof rounds used up" };
  }
  g.state = "fixing";
  const report = (ticketTurns(p).slice(-1)[0] || {}).report;
  const byId = new Map(members.map((m) => [m.id, m]));
  const targets = new Map();
  for (const b of rep.bugs) {
    const t = byId.get(b.id) || (spec && (b.id === spec.id || b.id === "spec") ? spec : null);
    if (t) targets.set(t, [...(targets.get(t) || []), b.reason]);
    else out.warnings.push(`${p.id}: bug for unknown ticket ${b.id}`);
  }
  if (rep.spec_bugs && spec && liveTicket(spec)) targets.set(spec, [...(targets.get(spec) || []), rep.spec_bugs]);
  // a failing verdict that names nobody goes to every worker of the group
  if (!targets.size) for (const m of members) targets.set(m, [rep.summary || "the proof failed"]);
  for (const [t, bugs] of targets) {
    addInput(state, t, { kind: "proof", text: `The proof worker (round ${g.runs} of at most ${cfg.proofRounds}) found defects to fix in this ticket:\n${bugs.map((b) => `  - ${b}`).join("\n")}\n  Full evidence: ${report}` });
    wake(state, t, { kind: "fix" });
  }
  // the others keep waiting for the next round
  for (const t of held) if (t.hold) t.hold.state = "proof";
  return { handoff: { kind: "none" }, note: `proof round ${g.runs} failed: defects went back to ${[...targets.keys()].map((t) => t.id).join(", ")}` };
}

/** Launch pending turns into free slots, people's messages first; one extra slot is kept for a person or a status request. */
async function promote(state, cfg, out) {
  if (cfg.paused) return;
  const pending = [];
  let running = 0;
  let extraUsed = false;
  const held = []; // the folders of exclusive turns that run
  for (const t of Object.values(state.tickets)) {
    if (!liveTicket(t)) continue;
    for (const a of t.assignments) {
      for (const turn of a.turns) {
        if (turn.state === "running") {
          running++;
          if (turn.extra) extraUsed = true;
          if (exclusive(cfg, state, t)) held.push(repoOf(t));
        } else if (turn.state === "pending" && a.state !== "ended") pending.push([t, a, turn]);
      }
    }
  }
  pending.sort((x, y) => Number(y[2].priority) - Number(x[2].priority) || x[2].seq - y[2].seq);
  // look for git where writers wait, so they need not run one at a time until a worker confirms it
  if (cfg.isolation === "auto") {
    for (const repo of new Set(pending.filter(([t]) => writes(t)).map(([t]) => repoOf(t)))) await probeGit(state, repo);
  }
  for (const [t, a, turn] of pending) {
    if (t.merge && t.merge.state === "merging") continue; // its branch is being merged: the turn waits
    if (afterOpen(state, t).length) continue; // it needs the results of tickets that have not ended yet
    ensureIsolation(state, cfg, t);
    const excl = exclusive(cfg, state, t);
    if (excl && held.some((r) => overlaps(r, repoOf(t)))) continue;
    let extra = false;
    if (running - (extraUsed ? 1 : 0) >= cfg.maxWorkers) {
      if (!turn.priority || extraUsed) continue;
      extra = true;
      extraUsed = true;
    }
    running++;
    if (excl) held.push(repoOf(t));
    // never start on an account that just hit a limit: each turn is a new Task, so it can move to a healthy model now
    if (a.model && a.model !== "inherit" && cooling(state, a.model)) {
      const next = healthyModel(state, t, a.model);
      if (next) {
        out.warnings.push(`${t.id}#${turn.n}: ${a.model} is rate-limited until ${state.cooldown[accountOf(a.model)].until}; it starts on ${next}`);
        a.model = next;
        t.model = next;
      }
    }
    turn.inputs = t.undelivered.splice(0);
    for (const id of turn.inputs) Object.assign(t.inputs.find((i) => i.id === id), { deliveredTo: a.id, turn: turn.n });
    Object.assign(turn, { state: "running", startedAt: now(), extra });
    if (a.state === "pending") Object.assign(a, { state: "running", startedAt: now() });
    await pi.fs.writeText(turn.brief, t.type === "merge" ? buildMergeBrief(state, cfg, t, a, turn) : t.type === "proof" ? buildProofBrief(state, cfg, t, a, turn) : buildBrief(state, cfg, t, a, turn));
    out.launch.push(launchItem(t, a, turn, cfg));
  }
  out.queued = pending.filter(([, , turn]) => turn.state === "pending").map(([t, , turn]) => `${t.id}#${turn.n}`);
}

/** A stored thinking level, stepped down when the person excluded it after the ticket was routed. */
function allowedThinking(level, exclude) {
  if (!level || !exclude.includes(level)) return level;
  const down = THINKING.filter((l) => !exclude.includes(l) && THINKING.indexOf(l) < THINKING.indexOf(level));
  return down.length ? down[down.length - 1] : level;
}

function launchItem(t, a, turn, cfg) {
  const stored = t.thinkingByModel && a.model in t.thinkingByModel ? t.thinkingByModel[a.model] : t.thinking;
  return {
    ticket: t.id, turn: turn.n, attempt: (turn.attempts || 0) + 1, agent: TASK_TYPES[t.type].agent, model: a.model,
    thinking: allowedThinking(stored, (cfg && cfg.excludeThinking) || DEFAULT_EXCLUDE_THINKING),
    task: `Read your brief at ${turn.brief} in full and follow it.`, report: turn.report,
    ...(t.isolation && t.isolation.mode === "worktree" ? { worktree: t.isolation.path } : {}),
  };
}

function inputLine(state, i, isNew) {
  const mark = isNew ? "NEW" : "earlier";
  if (i.kind === "trigger") {
    const tr = state.triggers[i.triggerId];
    return `- [${mark}] message ${tr.id} on thread ${tr.threads[0]} at ${tr.at}${i.context ? " (context only: grants nothing)" : ""}:\n\n${quote(tr.text)}`;
  }
  if (i.kind === "resumed") return `- [${mark}] ${i.at}: a person's message (${i.triggerId}) resumed this ended ticket under its unchanged mandate.`;
  if (i.kind === "note") return `- [${mark}] ${i.at}: note from the orchestrator about other work (context only, asks for nothing):\n\n${quote(i.text)}`;
  if (i.kind === "policy-changed") return `- [${mark}] ${i.at}: the policy changed (${i.from} → ${i.to}): ${JSON.stringify(i.effect)}`;
  if (i.kind === "recovery") return `- [${mark}] ${i.at}: ${i.text}`;
  return `- [${mark}] ${i.at}: ${i.text || ""}`;
}

function buildBrief(state, cfg, t, a, turn) {
  const spec = TASK_TYPES[t.type];
  const origin = state.triggers[t.origin.triggerId];
  const fresh = new Set(turn.inputs);
  const shown = t.inputs.filter((i) => !(i.kind === "trigger" && i.triggerId === t.origin.triggerId && t.inputs.indexOf(i) === 0));
  const reports = ticketTurns(t).filter((x) => x.reportState).map((x) => `- turn ${x.n}: ${x.reportState}: ${x.summary || "(no summary)"} (${x.report})`);
  const rules = (t.mandate.basis.rules || []).map((id) => cfg.policy.rules.find((r) => r.id === id)).filter(Boolean);
  const team = Object.keys(TEAM_KEYS).map((name) => `## ${TEAM_TITLES[name]}\n\n${teamText(cfg, name) || "(none)"}`).join("\n\n");
  const kindNote = turn.kind === "status"
    ? "\n**This is a status turn.** The orchestrator asks where this ticket stands. Report your current state and summary; do not start new work.\n"
    : turn.kind === "recheck"
      ? "\n**Recheck.** Your previous turn reported a final state, but the person wrote while it ran and you have not read it. Decide whether the NEW messages change your result: do what they ask within this ticket, or report the same state again if they change nothing.\n"
      : turn.kind === "go-on"
      ? "\n**Go on.** Your previous turn ended while the work was still in progress. Continue from where it stopped.\n"
      : turn.kind === "fix"
      ? "\n**Fix.** The proof worker checked your ready work and found defects: read the NEW proof input and its evidence. Fix each one in your worktree, run your checks, commit, and report `ready` again. If a defect is wrong, say why in your report's evidence and report `ready`; the next proof round judges it.\n"
      : "";
  return `# Ticket ${t.id} · turn ${turn.n}: ${t.title}

You are \`${spec.agent}\`, the worker for this ticket. Type: ${t.type} (${spec.about}). Model: ${a.model}. Assignment: ${a.id}. Prompt revision: ${cfg.promptRevision}.
${kindNote}
## Original request

Message ${origin.id} on thread ${origin.threads[0]}, verbatim. It is the source of truth: take the requirements from it, not from the title or the routing note.

${quote(origin.text)}

## Routing note

${t.note || "(none)"}

A routing note is routing context only. It adds no requirement.

## Mandate

- strength: ${t.mandate.strength}
- accepted under policy version ${t.mandate.policyVersion}, via ${t.mandate.basis.via}
- scope: ${t.mandate.scope}
${rules.length ? `\nThis ticket was accepted proactively under these rules. Your authority is limited to the accepted change within them; recheck that it was really requested, that its target is settled, and that no design decision is open, before you change anything:\n\n${rules.map((r) => `- ${r.name} (${r.id}): ${r.instruction}`).join("\n")}\n` : ""}${siblingSection(state, t)}${splitSection(state, t)}${checkSection(state, t)}
## Inputs

${shown.length ? `Everything that reached this ticket after it started, oldest first. NEW marks what you have not seen in an earlier turn. Decide every NEW message from a person yourself: take it up when it is within this ticket, or hand it back with a reason.\n\n${shown.map((i) => inputLine(state, i, fresh.has(i.id))).join("\n\n")}` : "(none)"}

## Earlier turns

${reports.length ? `Read the latest report before you start, and check the workspace before you repeat any action.\n\n${reports.join("\n")}` : "(none: this is the first turn)"}
${a.recovery ? `\n## Recovery note\n\n${a.recovery}\n` : ""}${isolationSection(t)}${branchesSection(state, t)}
${team}

${reportSection(turn, [
  ...(t.isolation && t.isolation.mode === "worktree" ? ["isolation: <worktree | none (you worked in the main checkout)>", "merge: <yes | no when your branch holds no change to land>"] : []),
  ...(maySplit(state, t) ? ["split: <name (type[, key=value…]): scope; name (type): scope; … when you split this ticket, or none>"] : []),
])}`;
}

/** First turn of a person's request: the worker may hand independent parts to parallel workers instead of doing all of it. */
function splitSection(state, t) {
  if (!maySplit(state, t)) return "";
  const depth = splitDepth(state, t);
  const again = depth ? ` This ticket is already a part of a split: split it again only when your part itself holds independent parts; its new parts join the other tickets of the request, and the merge waits for all of them.` : "";
  return `
## Parallel parts

Before you change anything, judge how far the request reaches. When it covers several independent parts, each big enough for a worker of its own, that other workers can do at the same time without changing the same files (for example the API, the web app, the tests and the docs of a change made throughout a project), split the ticket instead of doing all of it yourself. Prefer a split whenever two or more parts can run in parallel: that is faster, and each part gets the worker and model that fit its type of task.

- Change nothing. Remove your worktree and branch if you made them.
- Report \`state: dropped\`, a summary that names the parts, and one \`split:\` line with 2 to ${MAX_SPLIT} entries, separated by \`;\`: \`name (type): scope\`. \`name\` is a short slug, \`type\` one of ${ACCEPT_TYPES.join(", ")}, and \`scope\` one sentence that names the part (files, area) the new ticket owns. The scopes do not overlap and together cover the whole request.
- Give a part its own requirements after its type, as \`key=value\` flags: \`name (docs, quality=low, speed=high): scope\`. Keys: quality (low/normal/high/max), speed (low/normal/high), budget (low/normal/high), context (short/normal/long/huge), reasoning (true/false), vision (true/false). Flags you leave out come from this ticket. Use them so a mechanical part runs cheap and fast, and a subtle one gets reasoning.
- A part that needs the results of others (a comparison, an integration step): \`name (type) after name1, name2: scope\`. It starts once they ended. At least one part must start now.

Each part becomes a ticket with its own worker, in parallel, on the same request. Split only on this first turn. Do not split a sequence of steps where each needs the one before, or work you can finish well alone: then do the whole ticket yourself.${again}
`;
}

/** The other tickets one message started: each worker keeps to its own part. */
function siblingSection(state, t) {
  const sibs = (t.siblings || []).map((id) => state.tickets[id]).filter(Boolean);
  if (!sibs.length) return "";
  const after = (s) => (s.after && s.after.length ? ` (starts after ${s.after.join(", ")})` : "");
  const why = t.parent ? `The worker of ticket ${t.parent} found independent parts in the original request and split it into several tickets` : "The original request asks for several separate things, so it started several tickets";
  return `\n## Split request\n\n${why} that run in parallel; a ticket that needs the results of others starts after they end. Your part is the scope of your Mandate. These tickets own the other parts: leave them alone, and do not report their work as missing.\n\n${sibs.map((s) => `- ${s.id} (${s.type}): ${s.mandate.scope}${after(s)}`).join("\n")}\n\n${afterSection(state, t)}`;
}

/** The tickets whose results this ticket needs (`after`): they ended before it started, so their reports are final. */
function afterSection(state, t) {
  const pre = (t.after || []).map((id) => state.tickets[id]).filter(Boolean);
  if (!pre.length) return "";
  const line = (s) => {
    const last = [...ticketTurns(s)].reverse().find((x) => x.reportState);
    const outcome = s.ended ? s.ended.outcome : stageLabel(s);
    const where = s.merged ? " Its changes are merged into the main checkout." : "";
    return `- ${s.id} (${s.type}, ${outcome}): ${s.mandate.scope}\n  report: \`${last ? last.report : "(none)"}\`${last && last.summary ? `: ${last.summary}` : ""}${where}`;
  };
  return `## Results you build on\n\nThis ticket needs the results of these tickets of the same message, so it started after they ended. Read their reports before you start. Use their results and do not redo their work. If one did not complete and your part cannot be done without it, report blocked and name that ticket.\n\n${pre.map(line).join("\n")}\n\n`;
}

/** Where a writer works: its own git worktree and branch, or the shared checkout while no other writer runs there. */
function isolationSection(t) {
  const iso = t.isolation;
  if (!iso) return "";
  const repo = iso.repo || "";
  if (iso.mode === "shared") {
    return repo
      ? `\n## Workspace\n\nYou work in the main checkout of the project folder \`${repo}/\` (relative to the workspace root). Change files only under it. No other worker changes files there while your turn runs.\n`
      : "\n## Workspace\n\nYou work in the main checkout of the workspace. No other worker changes files while your turn runs.\n";
  }
  // git runs in the repository folder, so the worktree path in the commands is relative to it
  const wt = iso.wt || iso.path;
  const from = repo ? `the repository folder \`${repo}/\`` : "the workspace root";
  return `
## Workspace isolation

Other workers can change files at the same time as you. So this ticket works in its own git worktree, on its own branch. Never change files in the main checkout.
${repo ? `\n- repository: \`${repo}/\` (relative to the workspace root): the git repository this ticket changes. Run every git command below from there.` : ""}
- worktree: \`${iso.path}\` (relative to the workspace root)
- branch: \`${iso.branch}\`
- base ref: \`${iso.base}\`, the state your branch starts from. It includes the uncommitted changes the person had at that time.

1. **Set up the worktree** from ${from} before you change anything. The script skips what an earlier turn already did:

   \`\`\`sh
${repo ? `   cd ${repo}\n` : ""}   git rev-parse --is-inside-work-tree   # fails: not a git repository, see step 6
   x="$(git rev-parse --git-common-dir)/info/exclude"; grep -qxF '.superagent/' "$x" 2>/dev/null || echo '.superagent/' >> "$x"
   if ! git show-ref --verify --quiet refs/heads/${iso.branch}; then
     base=$(git stash create); [ -n "$base" ] || base=$(git rev-parse HEAD)
     git update-ref ${iso.base} "$base" && git worktree add -b ${iso.branch} ${wt} ${iso.base}
   elif [ ! -e ${wt}/.git ]; then
     git worktree prune && git worktree add ${wt} ${iso.branch}
   fi
   src=$(pwd); for d in $(git ls-files --others --ignored --exclude-standard --directory | grep -E '(^|/)(node_modules|\\.venv|venv|vendor|target|\\.tox|Pods)/$'); do
     [ -e "${wt}/\${d%/}" ] || { mkdir -p "${wt}/$(dirname "$d")" && ln -s "$src/\${d%/}" "${wt}/\${d%/}"; }
   done
   [ -x .superagent-setup.sh ] && (cd ${wt} && ./.superagent-setup.sh)
   \`\`\`

   The worktree does not contain the person's untracked files: copy the ones you need. It has no ignored files either: the script links the installed dependencies of the main checkout (\`node_modules\`, \`.venv\`, \`vendor\`, \`target\`, …) into it and runs the repository's tracked \`.superagent-setup.sh\` when there is one. Never run a dependency install in the worktree while other workers run: parallel installs contend on the package store, hold the host's command slots for minutes and stop every worker's shell. Install only what the links do not cover, and run any command that may take longer than a minute (installs, builds, full test suites) as a background task and wait for it.
2. **Work only in the worktree.** Read and edit the files under \`${iso.path}/\`, and run every command there (\`cd ${iso.path} && …\` from the workspace root).
3. **Commit your work on your branch** before you report \`ready\`. These local commits are part of the isolation and are always allowed. Never push, and never change another branch or the main checkout.
4. **Do not merge.** When you report \`ready\`, a merge worker lands your branch in the person's checkout, together with the work of the other workers.
5. Before you report \`dropped\`, or \`ready\` with \`merge: no\`, remove your worktree and branch from ${from}: \`git worktree remove --force ${wt}; git branch -D ${iso.branch}; git update-ref -d ${iso.base}\`.
6. If ${repo ? `\`${repo}/\`` : "the workspace"} is not a git repository, or git cannot make the worktree, work in the main checkout as usual${repo ? `, only under \`${repo}/\`,` : ""} and write \`isolation: none\` in your report.
`;
}

/** For read-only workers: the work that sits on ticket branches and is not in the main checkout yet. */
function branchesSection(state, t) {
  if (writes(t)) return "";
  const open = Object.values(state.tickets).filter((s) => s.id !== t.id && liveTicket(s) && s.isolation && s.isolation.mode === "worktree");
  if (!open.length) return "";
  return `\n## Ticket branches\n\nThese tickets work in their own git worktrees. Their changes are not in the main checkout until a merge lands them. To see the work of a ticket, read its worktree, or run \`git diff <base ref> <branch>\` from its repository folder (the workspace root when none is given).\n\n${open.map((s) => `- ${s.id} [${stageLabel(s)}]: ${s.isolation.repo ? `repository \`${s.isolation.repo}/\`, ` : ""}branch \`${s.isolation.branch}\`, worktree \`${s.isolation.path}\`, base ref \`${s.isolation.base}\``).join("\n")}\n`;
}

function reportSection(turn, extra = []) {
  return `## Report

Before you finish, write \`${turn.report}\` with a single Write, in exactly this form:

\`\`\`
state: progress | waiting | ready | blocked | failed | dropped
summary: <one sentence: the outcome a person can use>
human_action: <one concrete question for the person | none to clear a pending one; leave the line out to keep it>
question_for_trigger_id: <the message id that raised the question, or none>
reply_to_trigger_id: <the id of a person's question your summary answers, or none>
acked: <ids of NEW messages you took up as part of this ticket, comma-separated, or none>
handback: <id: one-sentence reason; for each NEW message beyond this ticket, separated by ;, or none>
unrelated: <thread key: one-sentence reason, for a thread attached to this ticket that is not about it, or none>
follow: <thread key: how it relates, for a thread you want to follow for context only, or none>
${extra.map((l) => `${l}\n`).join("")}---
<full evidence: what changed (files), checks actually run and their results, risks, what remains>
\`\`\`

Then reply with only the state line.
`;
}

/** The brief of a merge ticket: land every listed branch in the person's checkout, as one working change. */
function buildMergeBrief(state, cfg, t, a, turn) {
  const spec = TASK_TYPES.merge;
  // only the branches still waiting for this merge: a landed one is gone
  const items = (t.merges || []).map((id) => state.tickets[id]).filter((s) => s && s.isolation && s.isolation.mode === "worktree" && s.merge && s.merge.by === t.id);
  const fresh = new Set(turn.inputs);
  const reports = ticketTurns(t).filter((x) => x.reportState).map((x) => `- turn ${x.n}: ${x.reportState}: ${x.summary || "(no summary)"} (${x.report})`);
  const branch = (s) => {
    const origin = state.triggers[s.origin.triggerId];
    const last = [...ticketTurns(s)].reverse().find((x) => x.reportState === "ready");
    return `### ${s.id}: ${s.title}\n\n- branch: \`${s.isolation.branch}\`\n- base ref: \`${s.isolation.base}\`\n- worktree: \`${s.isolation.wt || s.isolation.path}\`${s.isolation.wt ? ` (relative to the repository folder; \`${s.isolation.path}\` from the workspace root)` : ""}\n- scope: ${s.mandate.scope}\n- report: \`${last ? last.report : "(none)"}\`${last && last.summary ? `: ${last.summary}` : ""}\n\nOriginal request (message ${origin.id}):\n\n${quote(origin.text)}`;
  };
  const delivery = teamText(cfg, "delivery");
  const repo = repoOf(t);
  const from = repo ? `the repository folder \`${repo}/\` (\`cd ${repo}\` from the workspace root)` : "the workspace root";
  return `# Ticket ${t.id} · turn ${turn.n}: ${t.title}

You are \`${spec.agent}\`, here as the **merge worker**. Type: merge (${spec.about}). Model: ${a.model}. Assignment: ${a.id}. Prompt revision: ${cfg.promptRevision}.

Workers did the tickets below in parallel, each in its own git worktree, on its own branch, and reported them ready. Your job: land all of them in the person's checkout (${repo ? `the git repository \`${repo}/\`` : "the workspace root"}) as one coherent change that works. You do not add features and you do not redo their work.

## Branches to land, in this order

${items.length ? items.map(branch).join("\n\n") : "(none: report dropped)"}

## How to merge

1. Read the report of each ticket, so you know what it changed and why.
2. From ${from}, land each branch in order. Its change is the diff from its base ref to its branch tip. The base already holds the uncommitted changes the person had then, so you apply only the work of the ticket:

   \`\`\`sh
   git diff --binary <base ref> <branch> | git apply --3way
   \`\`\`

   If git refuses because the person has local changes in those files, use \`git apply --reject\` and apply each \`.rej\` hunk by hand, then delete the \`.rej\` files.
3. Resolve every conflict so that the intent of each ticket stays. Use the reports and the original requests. Never drop the change of a ticket. Never discard, stash, reset or overwrite the person's own changes. If a conflict needs a choice that only the person can make, report \`waiting\` with that one question.
4. Leave the result as uncommitted changes in the working tree. Unstage what \`git apply --3way\` staged, unless the person had staged changes in the same files. Commit only when an original request or the Delivery requirements ask for it.
5. When all branches are in, run the relevant build, linter and tests in the main checkout, and fix what the combination broke.
6. Only when you report \`ready\` or \`dropped\`, clean up each landed branch from ${from}: \`git worktree remove --force <worktree>; git branch -D <branch>; git update-ref -d <base ref>\`. Keep every branch when you stop for another reason.

Report \`ready\` when every branch is landed and checked, and \`dropped\` only when no branch held a change to land. The summary is one sentence about the combined outcome the person can use now. In the evidence, give for each ticket what landed, each conflict and how you resolved it, and the checks you ran with their results.
${a.recovery ? `\n## Recovery note\n\n${a.recovery}\n` : ""}
## Earlier turns

${reports.length ? `Read the latest report and check \`git status\` before you repeat any action: an earlier turn may have landed some branches already.\n\n${reports.join("\n")}` : "(none: this is the first turn)"}

## Inputs

${t.inputs.length ? t.inputs.map((i) => inputLine(state, i, fresh.has(i.id))).join("\n\n") : "(none)"}

## Delivery requirements

${delivery || "(none)"}

${reportSection(turn)}`;
}

/** For the workers of a checked ticket: who writes the acceptance tests, who proves the work, and what a fix turn is. */
function checkSection(state, t) {
  const g = checkOf(state, t);
  if (!g) return "";
  const spec = g.spec ? state.tickets[g.spec] : null;
  if (t.type === "spec") {
    const members = g.members.map((id) => state.tickets[id]).filter(Boolean);
    const file = `${ticketDir(t.id)}/checklist.md`;
    return `
## Your job: acceptance checks

Other workers implement this request at the same time. You do not implement it, and you do not read their branches: your checks come from the request alone, so they catch what the implementation missed.

${members.map((m) => `- ${m.id} (${m.type}): ${m.mandate.scope}`).join("\n")}

1. Write \`${file}\` (relative to the workspace root, outside your worktree) with 3 to 10 numbered acceptance criteria. Each one is checkable: give the test that covers it, or the command or observation that shows it.
2. In your worktree, write acceptance tests in the project's own test framework and style, next to its existing tests. Test the behaviour the request asks for, through the most stable public surface, plus its main edge cases. Nothing more: small and sharp beats wide. The tests fail now; that is expected. Never change product code.
3. Where the request leaves a name or an interface open, use the most obvious choice and put a comment \`ASSUMPTION: …\` on the test. The proof worker may ask you to adapt it to what the implementation chose.
4. Commit the tests on your branch and report \`ready\`. When the project has no tests, or the change cannot be tested by code (looks, wording), write only the checklist and report \`ready\` with \`merge: no\`.

On a fix turn, the proof worker found that some of your tests are wrong: they contradict the request, or test a choice the request left open. Correct only those, commit, and report \`ready\` again.
`;
  }
  return `
## Quality check

When you report \`ready\`, your work is not merged at once. ${spec ? `Ticket ${spec.id} writes acceptance tests from the same request, in parallel; do not write them yourself, but your own unit tests are welcome. ` : ""}A proof worker on another model then ${spec ? "runs those tests on your work and " : ""}checks that it does what the request asks, fits the codebase and fits the other parts of the request. It sends defects back to you as a fix turn, until the work passes. So report \`ready\` only when your own checks pass.
`;
}

/** The brief of a proof ticket: check the ready work of its group, in one combined state, and judge it. */
function buildProofBrief(state, cfg, t, a, turn) {
  const spec0 = TASK_TYPES.proof;
  const g = checkOf(state, t) || { members: [], runs: 0 };
  const origin = state.triggers[t.origin.triggerId];
  const fresh = new Set(turn.inputs);
  const members = g.members.map((id) => state.tickets[id]).filter((x) => x && liveTicket(x));
  const spec = g.spec ? state.tickets[g.spec] : null;
  const reports = ticketTurns(t).filter((x) => x.reportState).map((x) => `- turn ${x.n}: ${x.reportState}: ${x.summary || "(no summary)"} (${x.report})`);
  const where = (s) => {
    const last = [...ticketTurns(s)].reverse().find((x) => x.reportState === "ready");
    const iso = s.isolation || {};
    const loc = iso.mode === "worktree"
      ? `${iso.repo ? `repository \`${iso.repo}/\`, ` : ""}branch \`${iso.branch}\`, base ref \`${iso.base}\`, worktree \`${iso.path}\``
      : "in the main checkout";
    return `- ${s.id} (${s.type}): ${s.mandate.scope}\n  ${loc}\n  latest report: \`${last ? last.report : "(none)"}\`${last && last.summary ? `: ${last.summary}` : ""}`;
  };
  const branches = [...members, spec].filter((s) => s && s.isolation && s.isolation.mode === "worktree");
  const repos = [...new Set(branches.map((s) => s.isolation.repo || ""))];
  const scratch = (r) => `${r ? `${r}/` : ""}${WORKTREE_DIR}/${t.id}`;
  const setup = branches.length ? `2. **Build the combined state** in a scratch worktree${repos.length > 1 ? " per repository" : ""}, never in the person's checkout:

${repos.map((r) => {
    const bs = branches.filter((s) => (s.isolation.repo || "") === r);
    return `   \`\`\`sh
${r ? `   cd ${r}\n` : ""}   git worktree remove --force ${WORKTREE_DIR}/${t.id} 2>/dev/null; git worktree add --detach ${WORKTREE_DIR}/${t.id} ${bs[0].isolation.branch}
   cd ${WORKTREE_DIR}/${t.id}
${bs.slice(1).map((s) => `   git diff --binary ${s.isolation.base} ${s.isolation.branch} | git apply --3way`).join("\n")}
   \`\`\``;
  }).join("\n\n")}

   A conflict between two tickets is a coherence defect: report it on both.` : "2. The work is in the main checkout. Read it there; change nothing.";
  return `# Ticket ${t.id} · turn ${turn.n}: ${t.title}

You are \`${spec0.agent}\`, here as the **proof worker**. Type: proof (${spec0.about}). Model: ${a.model}. Assignment: ${a.id}. Prompt revision: ${cfg.promptRevision}. Proof round ${g.runs} of at most ${cfg.proofRounds}.

Workers reported the tickets below ready. Before their work reaches the person, you decide whether it is good: it passes its acceptance tests, and it is coherent. You never fix anything yourself; you send precise defects back to the worker that owns them.

## Original request

${quote(origin.text)}

## Work to prove

${members.map(where).join("\n")}
${spec ? `\nAcceptance tests: ticket ${spec.id}, written from the request alone.\n${where(spec)}\n  checklist: \`${ticketDir(spec.id)}/checklist.md\`` : "\nNo acceptance tests were written for this request: use the project's own tests and the request."}

## How to prove

Be economical: read diffs and what they touch, not whole projects. Run the acceptance tests and the existing tests near the change, not every slow suite.

1. Read each latest report${spec ? " and the checklist" : ""}.
${setup}
3. **Quality.** Run ${spec ? "the acceptance tests, then " : ""}the project's relevant build, linter and tests in the combined state. Every failure is a defect, unless it fails the same way without this work.
4. **Coherence.** Read each diff (\`git diff <base ref> <branch>\`) and check that:
   - it does what the request asks, all of it, within its ticket's scope, and nothing it did not ask;
   - it follows the conventions around it: names, structure, error handling, style, existing helpers instead of new copies;
   - the parts fit together: shared names, interfaces and data agree, and nothing is done twice;
   - it leaves no debug output, dead code, stubs, TODOs, skipped or weakened tests.
5. ${branches.length ? `Remove the scratch worktree: \`git worktree remove --force ${WORKTREE_DIR}/${t.id}\`${repos.some(Boolean) ? " (from each repository folder)" : ""}.` : "Change nothing."}

A defect is something that is wrong or missing, with evidence. A taste of style that the codebase does not settle is not a defect. An acceptance test that contradicts the request, or that tests a name or interface the request left open where the implementation made a sound other choice, is a defect of the tests (\`spec_bugs\`), not of the work.

Report \`state: ready\` with your verdict, also when it is \`fail\`. Use \`blocked\` only when you cannot run the checks at all.
${a.recovery ? `\n## Recovery note\n\n${a.recovery}\n` : ""}
## Earlier rounds

${reports.length ? `Read your latest report: check that each defect it found is fixed, and look again at everything.\n\n${reports.join("\n")}` : "(none: this is the first round)"}

## Inputs

${t.inputs.length ? t.inputs.map((i) => inputLine(state, i, fresh.has(i.id))).join("\n\n") : "(none)"}

${reportSection(turn, [
    "verdict: <pass | fail>",
    "bugs: <ticket-id: what is wrong, where (file:line), how to see it (command or test); ticket-id: …> or none",
    "spec_bugs: <which acceptance tests are wrong, and why> or none",
  ])}`;
}

/** Parse a worker report: `key: value` header lines up to `---`, then the evidence. */
function parseReport(text) {
  const lines = str(text).replace(/\r\n/g, "\n").replace(/^\s*```[a-z]*\n/i, "").split("\n");
  const head = {};
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^\s*(---|```)\s*$/.test(lines[i])) {
      if (!Object.keys(head).length) continue;
      i++;
      break;
    }
    const m = /^\s*(?:[-*]\s+)?[*_`]*([a-z_]+)[*_`]*\s*:[*_`]*\s*(.*)$/i.exec(lines[i]);
    if (m && !(m[1].toLowerCase() in head)) head[m[1].toLowerCase()] = m[2].trim().replace(/^[*_`]+|[*_`]+$/g, "");
  }
  const none = (v) => !v || /^(none|null|n\/a|no|-)\.?$/i.test(v.trim());
  const value = (k) => (none(head[k]) ? null : head[k]);
  const ids = (k) => (value(k) || "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const pairs = (k) => (value(k) || "").split(";").map((x) => /^\s*(\S+?):\s+(.+)$/.exec(x)).filter(Boolean).map((m) => ({ id: m[1].trim(), reason: m[2].trim().slice(0, 300) }));
  const state = str(head.state).toLowerCase().replace(/[`*]/g, "").split(/[\s|,.]/)[0];
  return {
    state: REPORT_STATES.includes(state) ? state : null,
    summary: str(head.summary).slice(0, 600),
    // undefined: the line is absent, keep any pending question; null: none, clear it
    human_action: !("human_action" in head) ? undefined : value("human_action") && value("human_action").slice(0, 1000),
    question_for_trigger_id: value("question_for_trigger_id"),
    reply_to_trigger_id: value("reply_to_trigger_id"),
    acked: ids("acked"),
    handback: pairs("handback"),
    unrelated: pairs("unrelated"),
    follow: pairs("follow"),
    // first turn only: the parts a worker split its ticket into, `name (type[, key=value, …]) [after a, b]: scope; …`
    split: (value("split") || "").split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
      const m = /^([a-z0-9][\w.-]*)\s*\(\s*([a-z]+)\s*((?:,\s*[a-z]+\s*[=:]\s*[a-z0-9-]+\s*)*)\)(?:\s+after\s+([^:]+?))?\s*:\s*(.+)$/i.exec(x);
      return m ? { name: m[1], type: m[2].toLowerCase(), flags: m[3].replace(/^\s*,/, "").trim(), after: m[4] ? m[4].split(/[,\s]+/).filter(Boolean) : [], scope: m[5].trim().slice(0, 300) } : { invalid: x.slice(0, 120) };
    }),
    // writers in a worktree: where they worked, and whether their branch holds a change to land (null: not said)
    isolation: str(head.isolation).toLowerCase().trim() || null,
    merge: "merge" in head ? !/^(no|none|false|nothing)\b/i.test(str(head.merge).trim()) : null,
    // proof workers: the verdict, the defects per ticket, and the defects of the acceptance tests themselves
    verdict: ["pass", "fail"].includes(str(head.verdict).toLowerCase().replace(/[`*]/g, "").split(/[\s|,.]/)[0]) ? str(head.verdict).toLowerCase().replace(/[`*]/g, "").split(/[\s|,.]/)[0] : null,
    bugs: pairs("bugs"),
    spec_bugs: value("spec_bugs"),
    body: lines.slice(i).join("\n").trim(),
  };
}

function handoffFor(t, report) {
  if (t.attention && report.human_action) return { kind: "question", question: t.attention.question, purpose: "attention" };
  if (report.state === "ready") return { kind: "result", summary: report.summary, purpose: "result" };
  if (report.state === "blocked" || report.state === "failed") return { kind: report.state === "blocked" ? "blocker" : "failure", summary: report.summary, note: "no structured question: shown on the ticket list as needing a person" };
  return { kind: "none" };
}

/** Hand a message back from a ticket; it goes to Eval once no ticket owns it. */
function handBack(state, cfg, t, triggerId, reason, out) {
  const d = state.dispositions[triggerId];
  const tr = state.triggers[triggerId];
  if (!d || !tr || d.requeued || !d.fanout.includes(t.id) || (d.handbacks || []).some((h) => h.ticketId === t.id)) return false;
  (d.handbacks ||= []).push({ ticketId: t.id, reason, at: now() });
  if (!followupOwners(state, tr).length) toEval(state, cfg, tr, out);
  return true;
}

/** A writer's report says where it worked: git found means worktrees may run side by side in its repository folder; no git means one writer at a time there. */
function learnIsolation(state, t, rep) {
  if (!writes(t) || t.type === "merge" || !t.isolation || t.isolation.mode !== "worktree") return;
  const repo = repoOf(t);
  if (/^(none|shared|no\b)/.test(rep.isolation || "")) {
    t.isolation = { mode: "shared", ...(repo ? { repo } : {}) };
    if (vcsOf(state, repo) !== "git") setVcs(state, repo, "none");
  } else if (/^worktree/.test(rep.isolation || "")) setVcs(state, repo, "git");
}

function freshOut() {
  return { candidates: [], filtered: [], launch: [], queued: [], stopAgents: [], warnings: [], followUps: [] };
}
function result(out, extra) {
  const r = { ...extra };
  for (const k of ["candidates", "filtered", "launch", "stopAgents", "warnings", "followUps"]) if (out[k].length) r[k] = out[k];
  if (out.queued.length) r.queued = out.queued;
  return r;
}

/** Turns that ran far longer than a worker may: the host restarted or the orchestrator lost them. */
function recoverStale(state, cfg, out) {
  const cutoff = new Date(Date.now() - STALE_TURN_MS).toISOString();
  const tickets = Object.values(state.tickets).filter(liveTicket).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const t of tickets) {
    const a = latestAssignment(t);
    const turn = activeTurn(a);
    if (!turn || turn.state !== "running" || turn.startedAt > cutoff) continue;
    restartAssignment(state, t, `Turn ${turn.n} was cut off (host restarted). Check the workspace, the files you changed and any earlier report before you repeat any action.`, "host restarted");
    out.warnings.push(`${t.id}: turn ${turn.n} was cut off; a new assignment starts with a recovery note`);
  }
}

/** End the current assignment and start a new one for the same worker session; what the cut turn took is delivered again. */
function restartAssignment(state, t, recovery, reason) {
  const a = latestAssignment(t);
  if (a && a.state !== "ended") {
    for (const turn of a.turns) {
      if (turn.state === "ended") continue;
      if (turn.state === "running") for (const id of turn.inputs) if (!t.undelivered.includes(id)) t.undelivered.push(id);
      Object.assign(turn, { state: "ended", endedAt: now(), outcome: "cancelled" });
    }
    Object.assign(a, { state: "ended", endedAt: now(), endedReason: reason });
  }
  const next = { id: nextId(state, "a"), state: "pending", model: t.model, createdAt: now(), turns: [], ...(recovery ? { recovery } : {}) };
  t.assignments.push(next);
  const n = ticketTurns(t).length + 1;
  next.turns.push({ n, kind: "work", priority: false, state: "pending", createdAt: now(), seq: nextSeq(), attempts: 0, inputs: [], brief: briefFile(t.id, n), report: reportFile(t.id, n) });
}
// ---------- personas (~/.agents/subagents, through node:fs) ----------
const personaSource = () => path.join(__dirname, "subagents");
const personaTarget = () => path.join(os.homedir(), ".agents", "subagents");

const THINKING_LINE = /^thinkingLevel:[ \t]*(\S+)[ \t]*$/m;

/**
 * The persona text to install. The Task tool takes no thinking level, so the sub-agent runs at the
 * thinkingLevel of its definition: step it down past the levels in excludeThinking.
 */
function personaBody(name, exclude = DEFAULT_EXCLUDE_THINKING, fallbacks = []) {
  const text = fs.readFileSync(path.join(personaSource(), name), "utf8");
  const body = text.replace(THINKING_LINE, (line, level) => (THINKING.includes(level) ? `thinkingLevel: ${allowedThinking(level, exclude)}` : line));
  // the host moves a sub-agent that hit a limit to these models, in the same session, without a new launch
  return fallbacks.length ? body.replace(/^(thinkingLevel:.*)$/m, `$1\nfallbackModels: [${fallbacks.join(", ")}]`) : body;
}

const FALLBACK_LINE = /^fallbackModels:.*\n?/m;
/** A persona without the lines this plugin writes (thinking level, fallbacks), to tell an untouched installed copy from an edited one. */
const withoutThinking = (text) => String(text).replace(FALLBACK_LINE, "").replace(THINKING_LINE, "");

/**
 * The host's fallback models of each worker definition: one model per provider account, best first for the
 * worker's main task type, and never on the account of that type's first choice, which is the one that would
 * have hit the limit. Limits hold per account, so a second model on the same account would only wait again.
 */
function personaFallbacks(entries, cfg) {
  const out = {};
  if (!entries.length) return out;
  for (const agent of AGENTS) {
    const type = Object.keys(TASK_TYPES).find((k) => TASK_TYPES[k].agent === agent && !TASK_TYPES[k].internal);
    if (!type) continue;
    let route;
    try {
      route = routeTask({ id: `persona-${agent}`, type, req: normalizeRequirements({}, type).req }, routingContext(entries, cfg));
    } catch {
      continue;
    }
    if (!route.model || route.model === "inherit") continue;
    const ranked = [route.model, ...route.fallbacks, ...route.candidates.map((c) => c.split(" ")[0])];
    const seen = new Set([accountOf(route.model)]);
    const picks = [];
    for (const id of ranked) {
      if (picks.length >= MAX_FALLBACKS || seen.has(accountOf(id)) || matchesAny(id, cfg.exclude)) continue;
      seen.add(accountOf(id));
      picks.push(id);
    }
    out[agent] = picks;
  }
  return out;
}

function installPersonas(exclude = DEFAULT_EXCLUDE_THINKING, fallbacks = {}) {
  const dst = personaTarget();
  const wanted = new Set(AGENTS.map((a) => `${a}.md`));
  fs.mkdirSync(dst, { recursive: true });
  const changed = [];
  for (const name of wanted) {
    const body = Buffer.from(personaBody(name, exclude, fallbacks[name.replace(/\.md$/, "")] || []), "utf8");
    const target = path.join(dst, name);
    let current = null;
    try {
      current = fs.readFileSync(target);
    } catch {
      // missing
    }
    if (!current || !current.equals(body)) {
      fs.writeFileSync(target, body);
      changed.push(name);
    }
  }
  for (const name of fs.readdirSync(dst)) {
    if (!/^superagent-.*\.md$/.test(name) || wanted.has(name)) continue;
    const file = path.join(dst, name);
    if (fs.readFileSync(file, "utf8").includes(MARKER)) {
      fs.rmSync(file, { force: true });
      changed.push(`-${name}`);
    }
  }
  return changed;
}

/** Install the personas with the thinking levels the settings allow, and record the outcome. */
function syncPersonas(exclude, fallbacks) {
  try {
    const changed = installPersonas(exclude, fallbacks);
    if (changed.length) personaStatus = `installed or updated: ${changed.join(", ")}`;
    else if (!/^installed/.test(personaStatus)) personaStatus = "installed and up to date";
  } catch (e) {
    personaStatus = `could not install to ${personaTarget()}: ${e && e.message}`;
  }
}

/** Remove the personas this plugin installed, unless the user edited them (a thinking level we wrote does not count). */
function removePersonas() {
  for (const a of AGENTS) {
    const name = `${a}.md`;
    try {
      const installed = fs.readFileSync(path.join(personaTarget(), name), "utf8");
      if (withoutThinking(installed) === withoutThinking(fs.readFileSync(path.join(personaSource(), name), "utf8"))) {
        fs.rmSync(path.join(personaTarget(), name), { force: true });
      }
    } catch {
      // already gone, or never installed
    }
  }
}

// ---------- tool helpers ----------
/** Load, sweep (expired Evals, outdated Evals, cut-off turns), run, launch into free slots, save. */
async function withState(fn) {
  const cfg = await settings();
  const state = await loadState();
  const out = freshOut();
  if (!cfg.paused && !state.pausedAt) {
    expireEvals(state, cfg, out);
    requeueOutdated(state, cfg, out);
    recoverStale(state, cfg, out);
  }
  const value = await fn(state, cfg, out);
  await scheduleProofs(state, cfg, out);
  await scheduleMerges(state, cfg, out);
  await promote(state, cfg, out);
  // stages as they stand after the launch
  const refresh = (v) => {
    if (isObj(v) && typeof v.stage === "string" && v.ticket && state.tickets[v.ticket]) v.stage = stageLabel(state.tickets[v.ticket]);
  };
  refresh(value);
  if (isObj(value) && Array.isArray(value.results)) value.results.forEach(refresh);
  await saveState(state);
  return result(out, value);
}

function requireTicket(state, id) {
  const t = state.tickets[str(id).trim()];
  if (!t) fail(`unknown ticket ${JSON.stringify(id)}; superagent_ticket list shows the tickets`);
  return t;
}
function requireTrigger(state, id) {
  const tr = state.triggers[str(id).trim()];
  if (!tr) fail(`unknown message ${JSON.stringify(id)}`);
  return tr;
}
function checkWords(text, max, what) {
  const n = wordCount(text);
  if (n > max) fail(`${what} has ${n} words; the limit is ${max}`);
}
function uniqueTicketId(state, base, reserved = new Set()) {
  const free = (id) => !state.tickets[id] && !reserved.has(id);
  if (free(base)) return base;
  for (let i = 2; ; i++) if (free(`${base}-${i}`)) return `${base}-${i}`;
}

/** The Eval a candidate's trigger belongs to, refusing stale or unknown ones. */
function evalOf(state, cfg, triggerId, out) {
  const tr = requireTrigger(state, triggerId);
  const thread = state.threads[tr.threads[0]];
  const ev = thread.evaluating;
  if (!ev || !ev.triggerIds.includes(tr.id)) {
    const d = state.dispositions[tr.id];
    if (d.decisionId) fail(`message ${tr.id} is already decided (${d.decisionId})`);
    fail(`message ${tr.id} is not a waiting candidate${followupOwners(state, tr).length ? ": its tickets' workers decide it; you may only stop that work" : ""}`);
  }
  if (ev.policyVersion !== policyVersion(cfg)) {
    recordDecision(state, cfg, thread, ev, { kind: "unavailable", reason: [{ code: "policyChanged" }] }, out);
    thread.pending.unshift(...ev.triggerIds.filter((id) => !thread.pending.includes(id)));
    startEval(state, cfg, thread, out);
    fail(`the policy changed while ${tr.id} was being assessed; it is queued again under the current version`);
  }
  return { tr, thread, ev };
}

/**
 * `after` of each split ticket: names (or 0-based indexes) of other tickets of the same message whose results it
 * needs. Resolved to ticket ids on the drafts; an unknown name, a ticket that waits for itself, or a loop fails.
 */
function resolveAfter(specs, drafts, split) {
  const byName = new Map();
  drafts.forEach((d, k) => {
    for (const n of [d.id, str(specs[k].name).trim(), slug(specs[k].name || specs[k].title)]) if (n && !byName.has(n)) byName.set(n, k);
  });
  const deps = drafts.map((d, k) => {
    const raw = specs[k].after;
    if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) return [];
    if (!split) fail("after is only for tickets[]: it names other tickets of the same message");
    if (!Array.isArray(raw)) fail(`tickets[${k}]: after must be a list of names of other tickets of this message`);
    return [...new Set(raw.map((x) => {
      const j = Number.isInteger(x) ? x : byName.has(str(x).trim()) ? byName.get(str(x).trim()) : -1;
      if (j < 0 || j >= drafts.length) fail(`tickets[${k}]: after names ${JSON.stringify(x)}, which is not a ticket of this message`);
      if (j === k) fail(`tickets[${k}]: a ticket cannot wait for itself`);
      return j;
    }))];
  });
  const mark = drafts.map(() => 0);
  const visit = (k) => {
    if (mark[k] === 2) return;
    if (mark[k] === 1) fail(`after makes a loop through tickets[${k}]: the tickets of a loop would wait for each other forever`);
    mark[k] = 1;
    for (const j of deps[k]) visit(j);
    mark[k] = 2;
  };
  drafts.forEach((_, k) => visit(k));
  drafts.forEach((d, k) => { d.after = deps[k].map((j) => drafts[j].id); });
}

/**
 * Accept: one ticket per separate request of the message (`fields.tickets`), or one ticket for the whole message.
 * Each ticket gets its own Mandate scope and model, and is subscribed to the batch's threads. Everything is
 * checked before anything is written, so a bad item leaves no half-made tickets.
 */
function createTicket(state, cfg, catalog, thread, ev, fields, out) {
  if (!Array.isArray(fields.tickets) && fields.after !== undefined) fail("after is only for tickets[]: it names other tickets of the same message");
  const earlier = Object.values(state.tickets).find((x) => x.origin.triggerIds.includes(ev.primary));
  if (earlier) fail(`message ${ev.primary} already started ticket ${earlier.id}; attach to it or ignore`);
  const split = Array.isArray(fields.tickets) && fields.tickets.length > 0;
  if (split && fields.tickets.length > MAX_SPLIT) fail(`tickets holds at most ${MAX_SPLIT} requests`);
  if (split && fields.rules) fail("a proactive accept starts one ticket");
  const specs = split ? fields.tickets.map((x) => (isObj(x) ? x : {})) : [fields];
  const ack = str(fields.acknowledgement).trim();
  const ctx = routingContext(catalog.entries, cfg);
  for (const t of Object.values(state.tickets)) ctx.chosen.set(t.id, t.model);
  const reserved = new Set();
  const drafts = specs.map((spec, k) => {
    const where = split ? `tickets[${k}]: ` : "";
    const type = str(spec.type).trim();
    if (!ACCEPT_TYPES.includes(type)) fail(`${where}type must be one of ${ACCEPT_TYPES.join(", ")}`);
    const title = str(spec.title).trim();
    if (!title || title.length > 200) fail(`${where}title is required: a short label of the original request, at most 200 characters`);
    const note = str(spec.note).trim();
    checkWords(note, NOTE_WORDS, `${where}the routing note`);
    const scope = str(spec.scope).trim();
    if (split && !scope) fail(`${where}scope is required when one message starts several tickets: one sentence naming the part of the message this ticket owns`);
    const { req, warnings } = normalizeRequirements(spec.requirements, `${where}requirements`);
    out.warnings.push(...warnings);
    // a tickets[] entry without its own repo takes the item's
    const repo = normalizeRepo(spec.repo !== undefined ? spec.repo : split ? fields.repo : undefined, where);
    const check = checkLevel(cfg, type, spec.check !== undefined ? spec.check : split ? fields.check : undefined, where);
    const id = uniqueTicketId(state, slug(spec.name || title), reserved);
    reserved.add(id);
    const route = routeTask({ id, type, req }, ctx);
    ctx.chosen.set(id, route.model); // a later ticket of the same message may ask for differentFrom this one
    out.warnings.push(...route.warnings);
    return { id, type, title, note, req, route, repo, check, scope: scope || title };
  });
  resolveAfter(specs, drafts, split);
  if (fields.requireAck && !ack) fail("acknowledgement is required: one short sentence naming the concrete change and its intended result");
  checkWords(ack, IM_WORDS, "the acknowledgement");
  const ids = drafts.map((d) => d.id);
  const made = drafts.map((d) => {
    const { id, type, title, note, req, route, repo } = d;
    const mandate = {
      strength: ev.strength, policyVersion: ev.policyVersion,
      basis: { ...ev.basis, ...(fields.rules ? { rules: fields.rules } : {}) },
      actor: ev.actor, scope: d.scope,
    };
    const t = {
      id, title, type, decisionId: null, mandate, channels: [thread.key], attention: undefined, assignments: [], inputs: [],
      undelivered: [], answers: [], createdAt: now(), updatedAt: now(), origin: { triggerId: ev.primary, triggerIds: ev.triggerIds },
      note, req, ...(repo ? { repo } : {}), model: route.model, chain: [route.model, ...route.fallbacks], why: route.why, thinking: route.thinking,
      // the suggested thinking level of every model the ticket may run on, so a failover keeps a valid one
      thinkingByModel: Object.fromEntries([route.model, ...route.fallbacks].map((m) => [m, ctx.profiles.has(m) ? thinkingFor(type, req, ctx.profiles.get(m), ctx.excludeThinking) : route.thinking])),
      ...(split ? { siblings: ids.filter((x) => x !== id) } : {}),
      ...(d.after.length ? { after: d.after } : {}),
    };
    state.tickets[id] = t;
    for (const trId of [ev.primary, ...ev.triggerIds.filter((x) => x !== ev.primary)]) {
      const tr = state.triggers[trId];
      for (const key of tr.threads) if (!state.threads[key].subscriptions.includes(id)) state.threads[key].subscriptions.push(id);
      state.dispositions[trId].fanout.push(id);
      addInput(state, t, { kind: "trigger", triggerId: trId, human: tr.human, at: tr.at });
    }
    wake(state, t); // a new launch waits for a normal slot; the extra one is kept for a person's message
    return t;
  });
  const decision = recordDecision(state, cfg, thread, ev, {
    kind: "accept", ticketId: ids[0], ...(split ? { ticketIds: ids, mandates: Object.fromEntries(made.map((t) => [t.id, t.mandate])) } : { mandate: made[0].mandate }),
    reason: [{ code: "accepted", text: str(fields.reason) }], ...(fields.audit ? { audit: fields.audit } : {}),
  }, out);
  for (const t of made) t.decisionId = decision.id;
  // checks: the parts that start now are proved together, so the proof also sees whether they fit; a part that
  // needs the results of others starts after their merge, so it is proved on its own
  const lvl = (t) => drafts.find((d) => d.id === t.id).check;
  const first = made.filter((t) => !t.after && lvl(t) !== "none");
  if (first.length) createCheckGroup(state, cfg, ctx, first, first.some((t) => lvl(t) === "full") ? "full" : "proof", out);
  for (const t of made.filter((t) => t.after && lvl(t) !== "none")) createCheckGroup(state, cfg, ctx, [t], lvl(t), out);
  if (ack) {
    const rid = `ack:${ev.primary}`;
    if (!state.outbox.some((r) => r.id === rid)) state.outbox.push({ id: rid, purpose: "acknowledgement", ticketId: ids[0], ...(split ? { ticketIds: ids } : {}), triggerId: ev.primary, text: ack, at: now() });
  }
  const view = (d) => ({ ticket: d.id, agent: TASK_TYPES[d.type].agent, model: d.route.model, fallbacks: d.route.fallbacks, thinking: d.route.thinking, why: d.route.why, ...(d.check !== "none" ? { check: d.check } : {}) });
  const post = ack ? { post: ack } : {};
  if (split) return { tickets: drafts.map(view), decision: decision.id, ...post };
  return { ...view(drafts[0]), decision: decision.id, ...post };
}

/** A ticket may split itself on its first turn: a person's explicit request, not yet a part of a split, not a merge. */
/** A ticket may split once more while its chain of parents is shorter than this: a request, its parts, and their parts. */
const MAX_SPLIT_DEPTH = 2;
const splitDepth = (state, t) => {
  let d = 0;
  for (let p = t.parent; p && state.tickets[p] && d < 10; p = state.tickets[p].parent) d++;
  return d;
};
/** The first turn of a ticket a person asked for (or of a part of one, down to MAX_SPLIT_DEPTH) may split it. */
const maySplit = (state, t) => !TASK_TYPES[t.type].internal && t.mandate.strength === "explicit" && ticketTurns(t).length === 1 && splitDepth(state, t) < MAX_SPLIT_DEPTH;

/** Requirements of one split part: the parent's, with the `k=v` flags the worker wrote in its `(type, k=v, …)` on top. */
function partRequirements(parentReq, flags, where) {
  const given = {};
  for (const f of str(flags).split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^([a-z]+)\s*[=:]\s*([a-z0-9-]+)$/i.exec(f);
    if (!m) fail(`${where}: cannot read flag "${f}"; write key=value`);
    const k = m[1].toLowerCase();
    const v = m[2].toLowerCase();
    if (k === "vision" || k === "reasoning") given[k] = v === "true" || v === "yes" || v === "1";
    else given[k] = v;
  }
  const { req, warnings } = normalizeRequirements(given, where);
  const out = { ...parentReq };
  for (const k of Object.keys(given)) if (req[k] !== undefined) out[k] = req[k];
  return { req: out, warnings };
}

/**
 * The worker found that its ticket holds independent parts: one new ticket per part, in parallel (an entry with
 * `after` starts once those ended), under the same Mandate and message. Returns the new tickets' ids, or null with
 * a warning when the entries are not usable; the report is then handled as usual.
 */
function splitTicket(state, cfg, catalog, t, entries, out) {
  const bad = (why) => {
    out.warnings.push(`${t.id}: split ignored (${why})`);
    return null;
  };
  if (!maySplit(state, t)) return bad(`only the first turn of a ticket a person asked for may split, and a part at most ${MAX_SPLIT_DEPTH} levels deep`);
  if (entries.some((e) => e.invalid)) return bad(`cannot read "${entries.find((e) => e.invalid).invalid}"; write name (type): scope`);
  if (entries.length < 2 || entries.length > MAX_SPLIT) return bad(`it needs 2 to ${MAX_SPLIT} parts`);
  const wrong = entries.find((e) => !ACCEPT_TYPES.includes(e.type));
  if (wrong) return bad(`${wrong.name}: type must be one of ${ACCEPT_TYPES.join(", ")}`);
  // the parts join the parent's siblings: one group per message, so the merge still waits for all of them
  const kin = (t.siblings || []).filter((id) => state.tickets[id] && liveTicket(state.tickets[id]));
  if (entries.length + kin.length > MAX_SPLIT * MAX_SPLIT_DEPTH) return bad(`one request holds at most ${MAX_SPLIT * MAX_SPLIT_DEPTH} tickets`);
  const ctx = routingContext(catalog.entries, cfg);
  for (const x of Object.values(state.tickets)) ctx.chosen.set(x.id, x.model);
  const reserved = new Set();
  let drafts;
  try {
    drafts = entries.map((e) => {
      const id = uniqueTicketId(state, slug(`${t.id}-${e.name}`), reserved);
      reserved.add(id);
      const { req, warnings } = partRequirements(t.req, e.flags, e.name);
      out.warnings.push(...warnings);
      const route = routeTask({ id, type: e.type, req }, ctx);
      ctx.chosen.set(id, route.model);
      out.warnings.push(...route.warnings);
      return { id, route, req, ...e };
    });
  } catch (err) {
    return bad(err.message);
  }
  try {
    resolveAfter(entries, drafts, true);
  } catch (err) {
    return bad(err.message);
  }
  if (!drafts.some((d) => !d.after.length)) return bad("no part can start now");
  const ids = drafts.map((d) => d.id);
  const threads = Object.values(state.threads).filter((th) => th.subscriptions.includes(t.id) && !(th.context || []).includes(t.id));
  for (const d of drafts) {
    const { id, type, route, req } = d;
    const c = {
      id, title: `${t.title} (${d.name})`.slice(0, 200), type, decisionId: t.decisionId, mandate: { ...t.mandate, scope: d.scope },
      channels: [...t.channels], attention: undefined, assignments: [], inputs: [], undelivered: [], answers: [], createdAt: now(), updatedAt: now(),
      origin: { ...t.origin }, note: t.note, req, ...(t.repo ? { repo: t.repo } : {}), model: route.model, chain: [route.model, ...route.fallbacks], why: route.why, thinking: route.thinking,
      thinkingByModel: Object.fromEntries([route.model, ...route.fallbacks].map((m) => [m, ctx.profiles.has(m) ? thinkingFor(type, req, ctx.profiles.get(m), ctx.excludeThinking) : route.thinking])),
      siblings: [...ids.filter((x) => x !== id), ...kin], parent: t.id, ...(d.after.length ? { after: d.after } : {}),
    };
    state.tickets[id] = c;
    for (const th of threads) th.subscriptions.push(id);
    for (const trId of t.origin.triggerIds) {
      const tr = state.triggers[trId];
      if (!tr) continue;
      state.dispositions[trId].fanout.push(id);
      if (state.dispositions[trId].acked.includes(t.id)) state.dispositions[trId].acked.push(id);
      addInput(state, c, { kind: "trigger", triggerId: trId, human: tr.human, at: tr.at });
    }
    wake(state, c);
  }
  // the parent's siblings now see the parts in its place
  for (const sid of kin) {
    const s = state.tickets[sid];
    s.siblings = [...(s.siblings || []).filter((x) => x !== t.id), ...ids];
  }
  // the parts own the thread now: a follow-up goes to them, never back to the ticket that split
  for (const th of threads) th.subscriptions = th.subscriptions.filter((x) => x !== t.id);
  // checks: writer parts that start now take the split ticket's place in its group; a part that waits for others is proved alone
  const g = checkOf(state, t);
  if (g) {
    const parts = ids.map((id) => state.tickets[id]).filter((c) => writes(c));
    g.members = [...g.members.filter((id) => id !== t.id), ...parts.filter((c) => !c.after).map((c) => c.id)];
    for (const c of parts.filter((c) => !c.after)) c.check = g.id;
    const later = parts.filter((c) => c.after);
    if (later.length) {
      const lctx = routingContext(catalog.entries, cfg);
      for (const c of later) createCheckGroup(state, cfg, lctx, [c], "proof", out);
    }
  }
  t.splitInto = ids;
  return ids;
}

function turnOf(t, n) {
  for (const a of t.assignments) for (const turn of a.turns) if (turn.n === n) return { a, turn };
  return {};
}

// ---------- tools ----------
async function superConfig(args) {
  const a = isObj(args) ? args : {};
  const action = a.action || "get";
  if (action !== "get" && action !== "set") fail('action must be "get" or "set"');
  const before = await settings();
  if (action === "set") {
    const patch = {};
    if (a.clear === true) Object.assign(patch, { roleModels: {}, modelProfiles: {}, excludeModels: [], modelNotes: [] });
    const policy = JSON.parse(JSON.stringify(before.policy));
    let policyTouched = false;
    if (a.mode !== undefined) {
      if (!MODES.includes(a.mode)) fail(`mode must be one of ${MODES.join(", ")}`);
      policy.mode = a.mode;
      policyTouched = true;
    }
    if (a.rules !== undefined) {
      if (!Array.isArray(a.rules)) fail("rules must be the full list [{ id, name, enabled, instruction }]");
      const ids = new Set();
      policy.rules = a.rules.map((r, i) => {
        if (!isObj(r) || !RULE_ID_RE.test(str(r.id))) fail(`rules[${i}].id must match ${RULE_ID_RE}`);
        if (ids.has(r.id)) fail(`duplicate rule id ${r.id}`);
        ids.add(r.id);
        if (!str(r.instruction).trim()) fail(`rules[${i}].instruction is required`);
        return { id: r.id, name: str(r.name).trim() || r.id, enabled: r.enabled !== false, instruction: str(r.instruction).trim() };
      });
      policyTouched = true;
    }
    if (a.allowed !== undefined) {
      policy.sources[SOURCE].allowed = strList(a.allowed).map((id) => ({ id }));
      policyTouched = true;
    }
    if (a.admission !== undefined) {
      if (!isObj(a.admission)) fail("admission must be { listedUnaddressed?, unlistedAddressed?, unlistedUnaddressed? }");
      for (const [cell, value] of Object.entries(a.admission)) {
        if (!ADMISSION_OPTIONS[cell]) fail(`admission: unknown cell ${cell}`);
        if (!ADMISSION_OPTIONS[cell].includes(value)) fail(`admission.${cell} must be one of ${ADMISSION_OPTIONS[cell].join(", ")}`);
        policy.sources[SOURCE].admission[SOURCE][cell] = value;
      }
      policyTouched = true;
    }
    if (policyTouched) patch.policy = policy;
    if (a.proofRounds !== undefined) {
      if (!Number.isInteger(a.proofRounds) || a.proofRounds < 0 || a.proofRounds > MAX_PROOF_ROUNDS) fail(`proofRounds must be an integer from 0 to ${MAX_PROOF_ROUNDS}`);
      patch.proofRounds = a.proofRounds;
    }
    if (a.maxWorkers !== undefined) {
      if (!Number.isInteger(a.maxWorkers) || a.maxWorkers < 1 || a.maxWorkers > MAX_WORKERS) fail(`maxWorkers must be an integer from 1 to ${MAX_WORKERS}`);
      patch.maxWorkers = a.maxWorkers;
    }
    if (a.evalTimeoutSeconds !== undefined) {
      if (!Number.isInteger(a.evalTimeoutSeconds) || a.evalTimeoutSeconds < 30 || a.evalTimeoutSeconds > 3600) fail("evalTimeoutSeconds must be an integer from 30 to 3600");
      patch.evalTimeoutSeconds = a.evalTimeoutSeconds;
    }
    if (a.paused !== undefined) patch.paused = a.paused === true;
    if (a.isolation !== undefined) {
      if (!ISOLATION.includes(a.isolation)) fail(`isolation must be one of ${ISOLATION.join(", ")}`);
      patch.isolation = a.isolation;
    }
    if (a.roleModels !== undefined) {
      if (!isObj(a.roleModels)) fail("roleModels must be { taskType: [model, …] }");
      const pins = { ...(patch.roleModels || before.pins) };
      for (const [k, v] of Object.entries(a.roleModels)) {
        if (!TASK_TYPES[k]) fail(`roleModels: unknown task type ${k}; types are ${Object.keys(TASK_TYPES).join(", ")}`);
        const list = typeof v === "string" ? [v] : strList(v);
        if (list.length) pins[k] = list;
        else delete pins[k];
      }
      patch.roleModels = pins;
    }
    if (a.profiles !== undefined) {
      if (!isObj(a.profiles)) fail("profiles must be { glob: { reasoning|coding|writing|context|speed|cost: 1-5, vision|reasoningModel|unstable: bool, thinking: [levels] } }");
      const profiles = { ...(patch.modelProfiles || before.profiles) };
      for (const [k, v] of Object.entries(a.profiles)) {
        if (v === null) delete profiles[k];
        else if (isObj(v)) profiles[k] = v;
        else fail(`profiles.${k} must be an object or null`);
      }
      patch.modelProfiles = profiles;
    }
    if (a.exclude !== undefined || a.include !== undefined) {
      const ex = [...(patch.excludeModels || before.exclude)];
      for (const p of strList(a.exclude)) if (!ex.includes(p)) ex.push(p);
      patch.excludeModels = ex.filter((p) => !strList(a.include).includes(p));
    }
    if (a.excludeThinking !== undefined) {
      const list = strList(a.excludeThinking);
      const bad = list.filter((l) => !THINKING.includes(l));
      if (!Array.isArray(a.excludeThinking) || bad.length) fail(`excludeThinking must be an array of ${THINKING.join(", ")}`);
      if (THINKING.every((l) => list.includes(l))) fail("excludeThinking must leave at least one thinking level");
      patch.excludeThinking = THINKING.filter((l) => list.includes(l));
    }
    if (a.notes !== undefined) patch.modelNotes = [...new Set([...(patch.modelNotes || before.notes), ...strList(a.notes)])];
    if (isObj(a.team)) {
      for (const [name, text] of Object.entries(a.team)) {
        if (!TEAM_KEYS[name]) fail(`team: unknown section ${name}; sections are ${Object.keys(TEAM_KEYS).join(", ")}`);
        patch[TEAM_KEYS[name]] = str(text).trim();
      }
      patch.promptRevision = before.promptRevision + 1;
    }
    await pi.plugin.setSettings(patch);
  }
  const cfg = await settings();
  const catalog = await loadCatalog();
  // the installed worker definitions carry the thinking level and the fallback models; keep them in line with the settings
  syncPersonas(cfg.excludeThinking, personaFallbacks(catalog.entries, cfg));
  const ctx = routingContext(catalog.entries, cfg);
  return withState(async (state, _cfg, out) => {
    if (action === "set") {
      const from = policyVersion(before);
      const to = policyVersion(cfg);
      if (from !== to) {
        for (const [id, effect] of policyEffects(state, before, cfg)) {
          const t = state.tickets[id];
          addInput(state, t, { kind: "policy-changed", from, to, effect });
          wake(state, t);
        }
        requeueOutdated(state, cfg, out);
      }
      if (!before.paused && cfg.paused) state.pausedAt = now();
      if (before.paused && !cfg.paused) {
        const shift = state.pausedAt ? Date.now() - Date.parse(state.pausedAt) : 0;
        for (const thread of Object.values(state.threads)) {
          if (thread.evaluating) thread.evaluating.deadline = new Date(Date.parse(thread.evaluating.deadline) + shift).toISOString();
        }
        delete state.pausedAt;
        for (const thread of Object.values(state.threads)) startEval(state, cfg, thread, out);
        for (const t of Object.values(state.tickets)) if (liveTicket(t) && t.undelivered.length) wake(state, t);
      }
    }
    const warnings = [];
    if (catalog.note) warnings.push(catalog.note);
    for (const [type, list] of Object.entries(cfg.pins)) {
      for (const id of strList(list)) if (catalog.entries.length && !ctx.profiles.has(id)) warnings.push(`roleModels.${type}: ${id} is not among your sub-agent models`);
    }
    out.warnings.push(...warnings);
    const shown = {
      models: catalog.entries.map((e) => profileLine(e.id, ctx.profiles.get(e.id)) + (matchesAny(e.id, cfg.exclude) ? " EXCLUDED" : "")),
      legend: "R reasoning, C coding, W writing, X context, S speed, $ cheapness (1–5); * = overridden in settings",
      policy: { version: policyVersion(cfg), mode: cfg.policy.mode, rules: cfg.policy.rules, allowed: sourcePart(cfg).allowed, admission: { ...ADMISSION_DEFAULTS, ...sourcePart(cfg).admission[SOURCE] } },
      paused: cfg.paused, maxWorkers: cfg.maxWorkers, evalTimeoutSeconds: cfg.evalTimeoutSeconds, proofRounds: cfg.proofRounds,
      isolation: cfg.isolation,
      writers: parallelWriters(cfg, state) ? "in parallel, each in its own git worktree; a merge worker lands their branches"
        : cfg.isolation === "serial" || state.vcs === "none" ? "one at a time in the shared checkout"
          : "one at a time until git is found in the workspace (or a worker confirms it), then in parallel worktrees",
      repos: Object.fromEntries(Object.entries(state.repos || {}).map(([r, v]) => [r, parallelWriters(cfg, state, r) ? "parallel worktrees" : v === "none" ? "one writer at a time" : "unknown"])),
      cooldown: Object.fromEntries(Object.entries(state.cooldown || {}).filter(([, c]) => Date.parse(c.until) > Date.now()).map(([acct, c]) => [acct, `rate-limited until ${c.until} (${c.model})`])),
      roleModels: cfg.pins, overrides: cfg.profiles, exclude: cfg.exclude, excludeThinking: cfg.excludeThinking, notes: cfg.notes,
      team: Object.fromEntries(Object.keys(TEAM_KEYS).map((n) => [n, cfg.team[n] ? `custom (${cfg.team[n].length} chars)` : "default"])),
      promptRevision: cfg.promptRevision,
      taskTypes: Object.fromEntries(Object.entries(TASK_TYPES).map(([k, v]) => [k, `${v.agent}: ${v.about}`])),
      personas: personaStatus,
    };
    for (const name of strList(a.show)) if (TEAM_KEYS[name]) shown[`team_${name}`] = teamText(cfg, name);
    return shown;
  });
}

async function superModels(args) {
  const a = isObj(args) ? args : {};
  if (!Array.isArray(a.tasks) || !a.tasks.length) fail("tasks must be a non-empty array of { type, requirements }");
  const cfg = await settings();
  const catalog = await loadCatalog();
  const ctx = routingContext(catalog.entries, cfg);
  const state = await loadState();
  for (const t of Object.values(state.tickets)) ctx.chosen.set(t.id, t.model);
  const warnings = catalog.note ? [catalog.note] : [];
  const routes = a.tasks.map((raw, i) => {
    const r = isObj(raw) ? raw : {};
    const id = str(r.id).trim() || `task-${i + 1}`;
    const type = str(r.type).trim();
    if (!TASK_TYPES[type]) fail(`task ${id}: type must be one of ${Object.keys(TASK_TYPES).join(", ")}`);
    const { req, warnings: w } = normalizeRequirements(r.requirements, `task ${id}`);
    const route = routeTask({ id, type, req }, ctx);
    ctx.chosen.set(id, route.model);
    warnings.push(...w, ...route.warnings);
    const o = { id, type, agent: TASK_TYPES[type].agent, model: route.model, fallbacks: route.fallbacks, thinking: route.thinking, why: route.why };
    if (a.explain === true) o.candidates = route.candidates;
    return o;
  });
  return { routes, ...(warnings.length ? { warnings } : {}) };
}

async function superIntake(args) {
  const a = isObj(args) ? args : {};
  const text = str(a.text);
  if (!text.trim()) fail("text is required: the person's message, verbatim");
  return withState(async (state, cfg, out) => {
    let thread;
    if (a.thread) {
      thread = state.threads[str(a.thread).trim()];
      if (!thread) fail(`unknown thread ${JSON.stringify(a.thread)}`);
    } else {
      const key = `${SOURCE}:${state.seq + 1}`;
      thread = { key, createdAt: now(), subscriptions: [], context: [], correlated: [], pending: [], evaluating: null, expired: 0 };
      state.threads[key] = thread;
    }
    const trigger = {
      id: nextId(state, "m"), source: SOURCE, threads: [thread.key], actor: { source: SOURCE, id: str(a.actor).trim() || PERSON },
      human: true, ...(a.addressed === false ? {} : { addressed: "direct" }), at: now(), text,
    };
    state.triggers[trigger.id] = trigger;
    state.dispositions[trigger.id] = { fanout: [], context: [], handbacks: [], acked: [], at: now() };
    thread.lastAt = trigger.at;
    const d = state.dispositions[trigger.id];
    // subscription fan-out: every subscribed ticket receives it as context; a person's message there takes no Eval
    for (const id of thread.subscriptions) {
      const t = state.tickets[id];
      if (!t) continue;
      const context = (thread.context || []).includes(id);
      if (liveTicket(t)) {
        addInput(state, t, { kind: "trigger", triggerId: trigger.id, human: true, ...(context ? { context: true } : {}) });
        d.fanout.push(id);
        if (context) d.context.push(id);
        wake(state, t, { priority: !context });
      } else if (!context && t.ended.by !== "human") {
        if (!revalidate(cfg, t.mandate)) continue; // as if it reached no ticket
        t.ended = undefined;
        addInput(state, t, { kind: "resumed", triggerId: trigger.id });
        addInput(state, t, { kind: "trigger", triggerId: trigger.id, human: true });
        d.fanout.push(id);
        wake(state, t, { priority: true });
      }
    }
    const owners = followupOwners(state, trigger);
    if (owners.length) {
      out.followUps.push({ trigger_id: trigger.id, thread: thread.key, delivered_to: owners, note: "their workers decide this message; you may only stop that work, with superagent_route kind stop" });
      return { trigger_id: trigger.id, thread: thread.key, path: "follow-up" };
    }
    thread.pending.push(trigger.id);
    if (cfg.paused) return { trigger_id: trigger.id, thread: thread.key, path: "recorded while paused" };
    const card = startEval(state, cfg, thread, out);
    const filtered = out.filtered.find((f) => f.trigger_id === trigger.id);
    return {
      trigger_id: trigger.id, thread: thread.key,
      path: card && card.batch.some((b) => b.trigger_id === trigger.id) ? "eval" : filtered ? `not admitted (${filtered.reason})` : "queued behind the running eval of this thread",
    };
  });
}

async function superRoute(args) {
  const a = isObj(args) ? args : {};
  const items = Array.isArray(a.decisions) ? a.decisions : [];
  if (!items.length || items.length > 20) fail("decisions must hold 1 to 20 items");
  const catalog = await loadCatalog();
  return withState(async (state, cfg, out) => {
    if (cfg.paused) fail("processing is paused: decisions wait until it resumes");
    if (catalog.note) out.warnings.push(catalog.note);
    const results = [];
    for (const raw of items) {
      const it = isObj(raw) ? raw : {};
      try {
        results.push({ trigger_id: it.trigger_id, kind: it.kind, ok: true, ...routeOne(state, cfg, catalog, it, out) });
      } catch (e) {
        results.push({ trigger_id: it.trigger_id, kind: it.kind, ok: false, error: e.message });
      }
    }
    return { results };
  });
}

function routeOne(state, cfg, catalog, it, out) {
  const kind = str(it.kind);
  if (kind === "stop") return stopOne(state, cfg, it, out);
  const { tr, thread, ev } = evalOf(state, cfg, it.trigger_id, out);
  if (kind === "accept") {
    if (ev.strength !== "explicit") fail("an inferred candidate needs an assessment: use superagent_eval_decide");
    return createTicket(state, cfg, catalog, thread, ev, { ...it, requireAck: true }, out);
  }
  if (kind === "attach") {
    const t = requireTicket(state, it.ticket_id);
    if ((state.dispositions[tr.id].handbacks || []).some((h) => h.ticketId === t.id)) fail(`${t.id} handed this message back; attach it elsewhere, accept or ignore it`);
    if (t.ended && t.ended.by === "human") fail(`a person stopped ${t.id}; it receives nothing. Accept the message as new work instead.`);
    const note = str(it.note).trim();
    checkWords(note, NOTE_WORDS, "the routing note");
    if (t.ended) {
      if (!revalidate(cfg, t.mandate)) fail(`${t.id}'s mandate no longer holds under the current policy; accept the message as new work`);
      t.ended = undefined;
      addInput(state, t, { kind: "resumed", triggerId: tr.id });
    }
    for (const id of ev.triggerIds) {
      const x = state.triggers[id];
      for (const key of x.threads) if (!state.threads[key].subscriptions.includes(t.id)) state.threads[key].subscriptions.push(t.id);
      state.dispositions[id].fanout.push(t.id);
      addInput(state, t, { kind: "trigger", triggerId: id, human: x.human, ...(note ? { note } : {}) });
    }
    wake(state, t, { priority: true });
    const decision = recordDecision(state, cfg, thread, ev, { kind: "ignore", ticketId: t.id, reason: [{ code: "routed", ticketId: t.id }] }, out);
    return { ticket: t.id, decision: decision.id, stage: stageLabel(t) };
  }
  if (kind === "ignore") {
    const reason = str(it.reason).trim();
    if (!reason) fail("an ignore needs a reason");
    const decision = recordDecision(state, cfg, thread, ev, {
      kind: "ignore", reason: [{ code: "ignored", text: reason.slice(0, 500) }], ...(ev.strength === "inferred" ? { audit: { ignoredFromCard: true } } : {}),
    }, out);
    return { decision: decision.id };
  }
  return fail("kind must be accept, attach, stop or ignore");
}

/** A person's stop: allowed only from a message the gate admits as explicit; it ends that ticket's work for good. */
function stopOne(state, cfg, it, out) {
  const tr = requireTrigger(state, it.trigger_id);
  const t = requireTicket(state, it.ticket_id);
  const thread = state.threads[tr.threads[0]];
  const g = gate(state, cfg, tr, thread);
  const ev = thread.evaluating && thread.evaluating.triggerIds.includes(tr.id) ? thread.evaluating : null;
  const reasonText = str(it.reason).trim().slice(0, 500);
  const decide = (fields) => {
    if (ev) return recordDecision(state, cfg, thread, ev, fields, out);
    const decision = { id: nextId(state, "d"), evalId: null, threadKey: thread.key, triggerIds: [tr.id], policyVersion: policyVersion(cfg), at: now(), strength: g.strength || "explicit", ...fields };
    state.decisions.push(decision);
    state.dispositions[tr.id].decisionId = decision.id;
    return decision;
  };
  if (!g.admissible || g.strength !== "explicit") {
    const decision = decide({ kind: "ignore", ticketId: t.id, reason: [{ code: "stopNotExplicit" }] });
    fail(`only an explicit request from an allowed person can stop a ticket (recorded as ${decision.id})`);
  }
  if (t.ended) {
    const decision = decide({ kind: "ignore", ticketId: t.id, reason: [{ code: "stopUnknown", text: `${t.id} already ended (${t.ended.outcome})` }] });
    return { ticket: t.id, decision: decision.id, stage: stageLabel(t), note: `${t.id} had already ended (${t.ended.outcome})` };
  }
  // the decision is recorded first, so ending the ticket does not release the stop message itself
  const decision = decide({ kind: "stop", ticketId: t.id, reason: [{ code: "stopped", text: reasonText }] });
  endTicket(state, cfg, t, { by: "human", outcome: "stopped", reason: reasonText || undefined }, out);
  return { ticket: t.id, decision: decision.id, stage: stageLabel(t) };
}

async function superEvalDecide(args) {
  const a = isObj(args) ? args : {};
  const catalog = await loadCatalog();
  return withState(async (state, cfg, out) => {
    if (cfg.paused) fail("processing is paused: assessments wait until it resumes");
    const { thread, ev } = evalOf(state, cfg, a.trigger_id, out);
    if (ev.strength !== "inferred") fail("this candidate is an explicit request: route it with superagent_route");
    if (!["accept", "ignore", "unavailable"].includes(a.decision)) fail("decision must be accept, ignore or unavailable");
    const enabled = enabledRules(cfg);
    const judged = Array.isArray(a.rule_assessments) ? a.rule_assessments.filter(isObj) : [];
    const ids = new Set(judged.map((r) => r.rule_id));
    if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some((r) => !ids.has(r.id))) {
      fail(`rule_assessments must judge every enabled rule exactly once: ${enabled.map((r) => r.id).join(", ")}`);
    }
    for (const r of judged) if (typeof r.matched !== "boolean" || !str(r.reason).trim()) fail(`rule ${r.rule_id}: matched (boolean) and a factual reason are required`);
    const dir = isObj(a.direction) ? a.direction : null;
    const dirValid = dir && typeof dir.implementation_requested === "boolean" && ["specified", "existing-standard", "undetermined"].includes(dir.target_basis)
      && typeof dir.requires_design_decision === "boolean" && str(dir.evidence).trim();
    if (!dirValid) fail("direction is required: { implementation_requested, target_basis: specified|existing-standard|undetermined, requires_design_decision, evidence }");
    const matches = judged.filter((r) => r.matched).map((r) => ({ rule_id: r.rule_id, reason: r.reason }));
    const audit = { matches, rule_assessments: judged, direction: dir, ...(a.intent_evidence ? { intent_evidence: a.intent_evidence } : {}) };
    const reasonText = str(a.reason).trim().slice(0, 500);
    if (a.decision !== "accept") {
      const decision = recordDecision(state, cfg, thread, ev, { kind: a.decision, reason: [{ code: a.decision, text: reasonText }], audit }, out);
      return { decision: decision.id, kind: a.decision };
    }
    const settled = dir.implementation_requested && dir.target_basis !== "undetermined" && !dir.requires_design_decision;
    if (!settled) return { decision: recordDecision(state, cfg, thread, ev, { kind: "ignore", reason: [{ code: "directionUnsettled" }], audit }, out).id, kind: "ignore", why: "direction unsettled" };
    if (!matches.length) return { decision: recordDecision(state, cfg, thread, ev, { kind: "ignore", reason: [{ code: "noRuleMatched" }], audit }, out).id, kind: "ignore", why: "no rule matched" };
    if (!str(a.intent_evidence).trim()) fail("an accept requires intent_evidence: the three facts and their source quotes");
    if (cfg.policy.mode !== "auto") {
      const proposal = { title: a.title, scope: a.scope, name: a.name, type: a.type };
      const decision = recordDecision(state, cfg, thread, ev, { kind: "ignore", reason: [{ code: "observed", text: reasonText }], audit: { ...audit, would_accept: true, proposal } }, out);
      return { decision: decision.id, kind: "ignore", would_accept: true, why: `accept mode is ${cfg.policy.mode}: recorded only` };
    }
    if (!str(a.name).trim()) fail("an accept requires name: a short English name for the ticket");
    return { kind: "accept", ...createTicket(state, cfg, catalog, thread, ev, { ...a, rules: matches.map((m) => m.rule_id), audit, reason: reasonText }, out) };
  });
}

async function superReply(args) {
  const a = isObj(args) ? args : {};
  const purpose = str(a.purpose);
  if (!["result", "attention", "answer"].includes(purpose)) fail("purpose must be result, attention or answer");
  const text = str(a.text).trim();
  if (!text) fail("text is required");
  checkWords(text, IM_WORDS, "the message");
  return withState(async (state, cfg) => {
    if (cfg.paused) fail("processing is paused: replies wait until it resumes");
    const tr = a.trigger_id ? requireTrigger(state, a.trigger_id) : null;
    const t = a.ticket_id ? requireTicket(state, a.ticket_id)
      : tr ? Object.values(state.tickets).find((x) => state.dispositions[tr.id].fanout.includes(x.id) || x.origin.triggerIds.includes(tr.id)) : null;
    if (purpose === "result") {
      const outcome = t && t.ended && t.ended.outcome;
      const ready = outcome === "completed" || outcome === "dropped" || (t && liveTicket(t) && ticketStage(t).action === "review");
      if (!t || !ready) fail("a result needs a ticket that is ready, completed or dropped");
    }
    let id;
    if (purpose === "attention") {
      if (!t || !t.attention) fail("this ticket has no open question for a person");
      if (str(a.question).trim() !== t.attention.question) fail("question must be the ticket's open question, copied exactly");
      id = `attention-reply:${t.attention.id}`;
    } else {
      if (purpose === "answer" && !(tr && tr.human)) fail("an answer needs trigger_id: the person's question it answers");
      id = `reply:${(tr && tr.id) || (t && t.id)}:${crypto.createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
    }
    const existing = state.outbox.find((r) => r.id === id);
    if (existing) return { reused: true, note: "already sent; do not post it again" };
    if (purpose === "answer" && t && !(t.answers || []).includes(tr.id)) fail("the worker has not reported an answer to this question yet");
    state.outbox.push({ id, purpose, ticketId: t && t.id, triggerId: tr && tr.id, text, at: now() });
    if (purpose === "answer" && t) t.answers = t.answers.filter((x) => x !== tr.id);
    const asker = purpose === "attention" && t.attention.triggerId ? state.triggers[t.attention.triggerId] : null;
    return { post: text, thread: (asker && asker.threads[0]) || (tr && tr.threads[0]) || (t && t.channels[0]) };
  });
}

async function ticketReport(state, cfg, a, out) {
  const t = requireTicket(state, a.ticket);
  const n = Number.isInteger(a.turn) ? a.turn : ticketTurns(t).length;
  const { a: asg, turn } = turnOf(t, n);
  // the host may have hit a limit and moved the worker to a fallback model: no new launch goes to that account for a while
  const limited = learnLimits(state, [a.failures, a.error, a.text].map(str).join("\n"));
  if (limited.length) out.warnings.push(`rate-limited, cooling for ${LIMIT_COOLDOWN_MS / 60000} min: ${limited.join(", ")}`);
  if (!turn) fail(`ticket ${t.id} has no turn ${n}`);
  if (turn.state === "ended") return { ticket: t.id, stage: stageLabel(t), note: `turn ${n} is already recorded (${turn.outcome})`, handoff: { kind: "none" } };
  if (turn.state === "pending") fail(`turn ${n} of ${t.id} was never launched`);
  const outcome = a.outcome || "returned";
  if (outcome !== "returned" && outcome !== "error") fail('outcome must be "returned" or "error"');
  if (Number.isInteger(a.attempt) && a.attempt !== (turn.attempts || 0) + 1) {
    return { ticket: t.id, stage: stageLabel(t), note: `attempt ${a.attempt} of turn ${n} is already handled; the current attempt is ${(turn.attempts || 0) + 1}`, handoff: { kind: "none" } };
  }
  let text = await readOrNull(turn.report);
  if (text == null && outcome === "returned" && str(a.text).trim()) {
    text = str(a.text);
    await pi.fs.writeText(turn.report, text);
  }
  const rep = text == null ? null : parseReport(text);
  if (!rep || !rep.state) {
    const reason = outcome === "error" ? str(a.error).trim().slice(0, 300) || "the sub-agent failed"
      : text == null ? `no report at ${turn.report}` : `the report at ${turn.report} has no valid state line`;
    const limit = outcome === "error" && LIMIT.test(reason);
    const transient = outcome === "error" && TRANSIENT.test(reason);
    const from = asg.model || t.model;
    let nextModel;
    if (limit && ACCOUNT_LIMIT.test(reason)) {
      // an account limit holds for every ticket: cool the account, and move to a model that is not cooling
      coolAccount(state, from, reason);
      nextModel = healthyModel(state, t, from);
    } else {
      // a limit of this request (such as its context window): the next model of the chain, another provider first
      const rest = t.chain.slice(t.chain.indexOf(t.model) + 1);
      nextModel = rest.find((x) => accountOf(x) !== accountOf(t.model)) || rest[0];
    }
    if (limit && nextModel) {
      t.model = nextModel;
      restartAssignment(state, t, `Turn ${n} on ${from} hit a limit (${reason}). It may have changed files: check the workspace and any earlier report before you repeat an action.`, "model limit");
      return { ticket: t.id, stage: stageLabel(t), note: `limit on ${from}: failed over to ${nextModel}`, handoff: { kind: "none" } };
    }
    if ((transient || limit) && turn.attempts + 1 < TURN_RETRIES) {
      turn.attempts++;
      turn.startedAt = now();
      out.launch.push(launchItem(t, asg, turn, cfg));
      return { ticket: t.id, stage: stageLabel(t), note: `passing failure (${reason}): relaunch turn ${n} (attempt ${turn.attempts + 1} of ${TURN_RETRIES})`, handoff: { kind: "none" } };
    }
    for (const id of turn.inputs) if (!t.undelivered.includes(id)) t.undelivered.push(id);
    Object.assign(turn, { state: "ended", endedAt: now(), outcome: "failed", reportState: "failed", summary: `The worker's turn failed: ${reason}` });
    asg.report = { state: "failed", summary: turn.summary, at: now(), turn: n };
    return { ticket: t.id, stage: stageLabel(t), handoff: { kind: "failure", summary: turn.summary, note: "shown on the ticket list as needing a person; offer a retry" } };
  }
  const at = now();
  Object.assign(turn, { state: "ended", endedAt: at, outcome: "reported", reportState: rep.state, summary: rep.summary });
  asg.report = { state: rep.state, summary: rep.summary, at, turn: n };
  const triggerOk = (id) => id && state.triggers[id] && state.triggers[id].human;
  if (typeof rep.human_action === "string" && rep.human_action) {
    t.attention = { id: nextId(state, "q"), question: rep.human_action, ...(triggerOk(rep.question_for_trigger_id) ? { triggerId: rep.question_for_trigger_id } : {}) };
  } else if (rep.human_action === null) t.attention = undefined;
  if (triggerOk(rep.reply_to_trigger_id) && !(t.answers || []).includes(rep.reply_to_trigger_id)) (t.answers ||= []).push(rep.reply_to_trigger_id);
  const delivered = new Set(turn.inputs.map((id) => t.inputs.find((i) => i.id === id)).filter((i) => i && i.kind === "trigger").map((i) => i.triggerId));
  for (const id of rep.acked) if (delivered.has(id) && !state.dispositions[id].acked.includes(t.id)) state.dispositions[id].acked.push(t.id);
  const handbacks = [];
  for (const h of rep.handback) {
    if (handBack(state, cfg, t, h.id, h.reason, out)) handbacks.push(h);
    else out.warnings.push(`${t.id}: cannot hand back ${h.id} (not a message this ticket owns, or handed back already)`);
  }
  for (const u of rep.unrelated) {
    const thread = state.threads[u.id];
    if (!thread || !thread.subscriptions.includes(t.id) || t.channels.includes(u.id)) {
      out.warnings.push(`${t.id}: cannot drop thread ${u.id} (not attached, or the thread the ticket started on)`);
      continue;
    }
    thread.subscriptions = thread.subscriptions.filter((x) => x !== t.id);
    for (const [id, d] of Object.entries(state.dispositions)) {
      if (state.triggers[id].threads[0] === u.id && d.fanout.includes(t.id) && !d.acked.includes(t.id)) handBack(state, cfg, t, id, u.reason, out);
    }
  }
  for (const f of rep.follow) {
    const thread = state.threads[f.id];
    if (!thread) {
      out.warnings.push(`${t.id}: cannot follow unknown thread ${f.id}`);
      continue;
    }
    if (!thread.subscriptions.includes(t.id)) {
      thread.subscriptions.push(t.id);
      (thread.context ||= []).push(t.id);
    }
  }
  learnIsolation(state, t, rep);
  if (rep.split.length) {
    const ids = rep.state === "dropped" ? splitTicket(state, cfg, await loadCatalog(), t, rep.split, out)
      : (out.warnings.push(`${t.id}: split ignored (a ticket that splits reports dropped and changes nothing)`), null);
    if (ids) {
      endTicket(state, cfg, t, { by: "executor", outcome: "split" }, out);
      return { ticket: t.id, stage: stageLabel(t), split: ids, note: `split by its worker into ${ids.join(", ")}: launch them; the person hears their results`, handoff: { kind: "none" } };
    }
  }
  const human = hasHumanUndelivered(t);
  // the person wrote while this turn ran and the worker could not read it: it reads it before the ticket ends
  const recheck = human && (rep.state === "ready" || rep.state === "dropped");
  // checked work waits for its proof first: it reaches the merge, or the person, only once it passed
  const g = checkOf(state, t);
  const toProof = !recheck && rep.state === "ready" && t.type !== "proof" && rep.merge !== false && !!g && g.state !== "passed" && g.state !== "escalated" && g.state !== "closed";
  // a writer's ready branch waits for the merge worker; the person hears the result once it is landed
  const toMerge = !recheck && !toProof && rep.state === "ready" && t.type !== "merge" && t.type !== "proof" && t.isolation && t.isolation.mode === "worktree" && rep.merge !== false;
  let merged = null;
  let proved = null;
  if (recheck) wake(state, t, { kind: "recheck", priority: true });
  else if (t.type === "merge" && (rep.state === "ready" || rep.state === "dropped")) merged = finishMerge(state, cfg, t, rep, out);
  else if (t.type === "proof" && rep.state === "ready") proved = finishProof(state, cfg, t, rep, out);
  else if (toProof) t.hold = { state: "proof", at, turn: n };
  else if (toMerge) t.merge = { state: "queued", at, turn: n };
  else if (rep.state === "ready") endTicket(state, cfg, t, { by: "executor", outcome: "completed" }, out);
  else if (rep.state === "dropped") endTicket(state, cfg, t, { by: "executor", outcome: "dropped" }, out);
  if (liveTicket(t) && rep.state === "progress" && turn.kind !== "status") {
    let goOn = 0;
    for (const x of [...asg.turns].reverse()) {
      if (x.kind !== "go-on") break;
      goOn++;
    }
    if (goOn < GO_ON_LIMIT) wake(state, t, { kind: "go-on", priority: human });
  }
  if (liveTicket(t) && t.undelivered.length) wake(state, t, { priority: human });
  const answer = triggerOk(rep.reply_to_trigger_id) ? { trigger_id: rep.reply_to_trigger_id, summary: rep.summary } : undefined;
  let handoff = recheck || toMerge || toProof ? { kind: "none" } : proved ? proved.handoff : handoffFor(t, rep);
  if (merged && merged.length) handoff = { kind: "result", summary: rep.summary, purpose: "result", merged };
  const held = recheck ? { note: `held: the person wrote while turn ${n} ran; the worker reads it before reporting ${rep.state} again` }
    : toProof ? { note: "ready: held for its proof; it goes to the merge, or to the person, once the proof passes" }
    : proved ? { note: proved.note }
    : toMerge ? { note: `ready on branch ${t.isolation.branch}: queued for the merge worker; the result goes to the person once it is landed` } : {};
  return { ticket: t.id, stage: stageLabel(t), handoff, ...held, ...(answer ? { answer } : {}), ...(handbacks.length ? { handbacks } : {}) };
}

async function superTicket(args) {
  const a = isObj(args) ? args : {};
  const action = a.action || "list";
  if (action === "read") {
    const state = await loadState();
    const t = requireTicket(state, a.ticket);
    const last = [...ticketTurns(t)].reverse().find((x) => x.reportState);
    let latest = last ? await readOrNull(last.report) : null;
    if (latest && latest.length > 6000) latest = `${latest.slice(0, 6000)}\n… (truncated; read ${last.report})`;
    return {
      ticket: t.id, title: t.title, type: t.type, stage: stageLabel(t), model: t.model, chain: t.chain, why: t.why, mandate: t.mandate,
      attention: t.attention || null, ended: t.ended || null, threads: Object.values(state.threads).filter((th) => th.subscriptions.includes(t.id)).map((th) => th.key),
      assignments: t.assignments.map((x) => `${x.id} ${x.state}${x.endedReason ? ` (${x.endedReason})` : ""} on ${x.model}: ${x.turns.map((y) => `#${y.n} ${y.state}${y.reportState ? `/${y.reportState}` : ""}`).join(", ")}`),
      undelivered: t.undelivered.length, latestReport: latest,
      ...(t.isolation ? { isolation: t.isolation } : {}), ...(t.merge ? { merge: t.merge } : {}), ...(t.merges ? { merges: t.merges } : {}),
      ...(t.siblings ? { siblings: t.siblings } : {}),
      ...(t.parent ? { parent: t.parent } : {}),
      ...(t.splitInto ? { splitInto: t.splitInto } : {}),
      ...(t.after ? { after: t.after, waitsFor: afterOpen(state, t) } : {}),
    };
  }
  return withState(async (state, cfg, out) => {
    if (action === "list") return ticketList(state, cfg);
    if (action === "report") return ticketReport(state, cfg, a, out);
    if (action === "retry") {
      const t = requireTicket(state, a.ticket);
      if (!liveTicket(t) || !waitsForPerson(t)) fail(`retry is for an open ticket that is blocked or failed; ${t.id} is ${stageLabel(t)}`);
      const model = str(a.model).trim();
      if (model) {
        const catalog = await loadCatalog();
        if (!t.chain.includes(model) && !catalog.entries.some((e) => e.id === model)) fail(`${model} is not among your sub-agent models`);
        if (!t.chain.includes(model)) t.chain.splice(t.chain.indexOf(t.model) + 1, 0, model);
        const entry = catalog.entries.find((e) => e.id === model);
        if (entry) (t.thinkingByModel ||= {})[model] = thinkingFor(t.type, t.req, profileOf(entry, cfg.profiles), cfg.excludeThinking);
        t.model = model;
      }
      restartAssignment(state, t, null, "retry");
      return { ticket: t.id, stage: stageLabel(t), model: t.model };
    }
    if (action === "recover") {
      const t = requireTicket(state, a.ticket);
      const asg = latestAssignment(t);
      const turn = activeTurn(asg);
      if (!liveTicket(t) || !turn || turn.state !== "running") fail(`${t.id} has no running turn to recover (${stageLabel(t)})`);
      restartAssignment(state, t, `Turn ${turn.n} was lost (the session or the app restarted). Check the workspace, the files you changed and any earlier report before you repeat any action.`, "host restarted");
      return { ticket: t.id, stage: stageLabel(t) };
    }
    if (action === "status") {
      const t = requireTicket(state, a.ticket);
      const asg = latestAssignment(t);
      if (!liveTicket(t) || (asg && activeTurn(asg))) fail(`${t.id} is ${stageLabel(t)}: a status request is only for an open ticket whose worker is idle`);
      const r = latestReport(t);
      if (r && !["progress", "waiting"].includes(r.state)) fail(`${t.id} already reported ${r.state}: ${r.summary}`);
      wake(state, t, { kind: "status", priority: true });
      return { ticket: t.id };
    }
    if (action === "note") {
      const t = requireTicket(state, a.ticket);
      if (!liveTicket(t)) fail(`${t.id} has ended`);
      const text = str(a.text).trim();
      if (!text) fail("text is required: one fact from other work");
      checkWords(text, NOTE_FACT_WORDS, "the note");
      addInput(state, t, { kind: "note", text });
      wake(state, t);
      return { ticket: t.id };
    }
    if (action === "unsubscribe") {
      const thread = state.threads[str(a.thread).trim()];
      if (!thread) fail(`unknown thread ${JSON.stringify(a.thread)}`);
      const dropped = thread.subscriptions.splice(0);
      thread.context = [];
      return { thread: thread.key, dropped };
    }
    if (action === "requeue") {
      const tr = requireTrigger(state, a.trigger_id);
      const d = state.dispositions[tr.id];
      const owners = followupOwners(state, tr);
      if (owners.length) fail(`${owners.join(", ")} still decide ${tr.id}; only a stop of that work is possible`);
      d.requeued = true;
      delete d.decisionId;
      delete d.filtered;
      toEval(state, cfg, tr, out);
      return { trigger_id: tr.id };
    }
    if (action === "dismiss") {
      const decision = state.decisions.find((x) => x.id === str(a.decision).trim());
      if (!decision || decision.kind !== "unavailable") fail("dismiss takes the id of an unavailable decision");
      decision.dismissed = true;
      return { decision: decision.id };
    }
    if (action === "merge") {
      // queue again the branches a stopped merge left unmerged: one ticket, or all of them
      const pick = a.ticket ? [requireTicket(state, a.ticket)] : Object.values(state.tickets).filter((t) => liveTicket(t) && t.merge && t.merge.state === "unmerged");
      for (const t of pick) if (!liveTicket(t) || !t.merge || t.merge.state !== "unmerged") fail(`${t.id} has no unmerged branch (${stageLabel(t)})`);
      if (!pick.length) fail("no ticket has an unmerged branch");
      for (const t of pick) t.merge = { state: "queued", at: now() };
      return { queued: pick.map((t) => t.id) };
    }
    return fail("action must be one of list, read, report, retry, recover, status, note, unsubscribe, requeue, dismiss, merge");
  });
}

/** The overview: what waits for a person first, then working, queued and idle tickets; a healthy state takes no space. */
function ticketList(state, cfg) {
  const order = ["person/answer", "person/review", "person/blocked", "person/failed", "working", "working/proof", "working/merge", "working/queued", "idle"];
  const line = (t) => `${t.id} [${stageLabel(t)}] ${t.type} on ${t.model}: ${t.title}${t.attention ? ` · asks: ${t.attention.question}` : ""}`
    + `${t.merge && t.merge.state === "unmerged" ? ` · branch ${t.isolation.branch} not merged (superagent_ticket merge)` : ""}`
    + `${afterOpen(state, t).length ? ` · waits for ${afterOpen(state, t).join(", ")}` : ""}`;
  const tickets = Object.values(state.tickets);
  const open = tickets.filter(liveTicket).sort((a, b) => order.indexOf(stageLabel(a)) - order.indexOf(stageLabel(b)));
  const ended = tickets.filter((t) => !liveTicket(t)).sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt))).slice(0, 10);
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const unavailable = state.decisions.filter((d) => d.kind === "unavailable" && !d.dismissed && d.at > dayAgo
    && state.decisions.filter((x) => x.threadKey === d.threadKey).pop() === d
    && !state.threads[d.threadKey].evaluating && !state.threads[d.threadKey].pending.length);
  const waiting = Object.values(state.threads).filter((th) => th.evaluating).map((th) => candidateCard(state, cfg, th, th.evaluating));
  const running = tickets.reduce((n, t) => n + ticketTurns(t).filter((x) => x.state === "running").length, 0);
  const o = {};
  if (cfg.paused) o.paused = "processing is paused: no evals, launches or replies until it resumes";
  const person = open.filter((t) => stageLabel(t).startsWith("person/")).map(line);
  if (person.length) o.needsPerson = person;
  if (unavailable.length) o.unavailable = unavailable.map((d) => `${d.id} on ${d.threadKey} (${d.triggerIds.join(", ")}): ${d.reason.map((r) => r.code).join(", ")}`);
  if (waiting.length) o.waitingCandidates = waiting;
  const rest = open.filter((t) => !stageLabel(t).startsWith("person/")).map(line);
  if (rest.length) o.open = rest;
  if (ended.length) o.recentlyEnded = ended.map(line);
  o.slots = `${running}/${cfg.maxWorkers} running`;
  return o;
}

// ---------- tool declarations ----------
const REQ_SCHEMA = {
  type: "object",
  description: "optional: quality low|normal|high|max, speed low|normal|high, budget low|normal|high, context short|normal|long|huge, vision bool, reasoning bool, thinking level, differentFrom [ticket ids], prefer [globs], avoid [globs]",
};
const TYPES = ACCEPT_TYPES;
const ACCEPT_FIELDS = {
  title: { type: "string", description: "accept: short label of the request, ≤200 chars" },
  name: { type: "string", description: "accept: short English name, becomes the ticket id" },
  acknowledgement: { type: "string", description: `accept: one sentence in the person's language naming the concrete change and result, ≤${IM_WORDS} words` },
  note: { type: "string", description: `optional: routing background or a limit the person stated, ≤${NOTE_WORDS} words; never instructions` },
  type: { type: "string", enum: TYPES, description: "accept: picks the worker and its model" },
  requirements: REQ_SCHEMA,
  scope: { type: "string", description: "accept: one sentence naming the work allowed; defaults to the title" },
  check: { type: "string", enum: CHECK_LEVELS, description: "accept: check before merge. full: acceptance tests + proof on another model; proof: proof only; none: trivial change. Default full (code, debug), proof (test), none (docs)" },
  repo: { type: "string", description: "accept: optional project folder (own git repo inside a multi-project workspace), relative to the workspace root; omit when the root is the repo" },
};

const TOOLS = [
  {
    name: "superagent_config",
    description: "LLM Superagent: get or set policy, slots, role models, model traits, exclusions, team sections; lists sub-agent models. Only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"] },
        mode: { type: "string", enum: MODES, description: "set: accept mode for proactive (inferred) candidates" },
        rules: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" }, instruction: { type: "string" } } }, description: "set: the full rule list" },
        allowed: { type: "array", items: { type: "string" }, description: "set: sender ids allowed to request work (default [\"person\"])" },
        admission: { type: "object", description: "set: { listedUnaddressed: inferred|ignore, unlistedAddressed: explicit|inferred|ignore, unlistedUnaddressed: inferred|ignore }" },
        proofRounds: { type: "integer", description: `set: failed proof rounds before the person decides, 0–${MAX_PROOF_ROUNDS} (default ${DEFAULT_PROOF_ROUNDS}); 0 turns checks off` },
        maxWorkers: { type: "integer", description: `set: concurrent worker turns, 1–${MAX_WORKERS} (default ${DEFAULT_WORKERS})` },
        evalTimeoutSeconds: { type: "integer", description: `set: seconds a candidate waits for a decision, 30–3600 (default ${DEFAULT_EVAL_TIMEOUT})` },
        paused: { type: "boolean", description: "set: pause processing; messages are still recorded" },
        isolation: { type: "string", enum: ISOLATION, description: "set: writers in git worktrees once git is confirmed (auto, default), from the start (worktree), or one at a time (serial)" },
        roleModels: { type: "object", description: "set: { taskType: [model, fallback, …] }; [] removes a pin" },
        profiles: { type: "object", description: "set: { glob: { reasoning|coding|writing|context|speed|cost: 1-5, vision|reasoningModel|unstable: bool, thinking: [levels] } }; null removes" },
        exclude: { type: "array", items: { type: "string" }, description: "set: model id globs never to use" },
        include: { type: "array", items: { type: "string" }, description: "set: exclusion globs to remove" },
        excludeThinking: { type: "array", items: { type: "string", enum: THINKING }, description: "set: thinking levels workers never get (default [\"high\", \"xhigh\", \"max\"]; [] allows all)" },
        notes: { type: "array", items: { type: "string" } },
        team: { type: "object", description: "set: { communication|scope|delivery: text }; \"\" restores the default" },
        show: { type: "array", items: { type: "string" }, description: "get: team sections to return in full" },
        clear: { type: "boolean", description: "set: reset role models, overrides, exclusions and notes first" },
      },
    },
    execute: superConfig,
  },
  {
    name: "superagent_models",
    description: "LLM Superagent: preview the model, fallbacks and thinking level a task type and requirements get. Only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string", enum: TYPES }, requirements: REQ_SCHEMA }, required: ["type"] } },
        explain: { type: "boolean", description: "also return the top 5 candidates with scores" },
      },
      required: ["tasks"],
    },
    execute: superModels,
  },
  {
    name: "superagent_intake",
    description: "LLM Superagent: record a person's message verbatim; a thread reply goes to that ticket's worker, anything else returns a candidate card. Only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The person's message, verbatim" },
        addressed: { type: "boolean", description: "false for shared material, an aside or thinking aloud; default true" },
        thread: { type: "string", description: "only when the message replies within an existing thread: its key" },
      },
      required: ["text"],
    },
    execute: superIntake,
  },
  {
    name: "superagent_route",
    description: "LLM Superagent: decide explicit candidate cards: accept (one ticket, or tickets[] per named part), attach, stop or ignore; items are independent. Only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["accept", "attach", "stop", "ignore"] },
              trigger_id: { type: "string", description: "the card's trigger_id (a follow-up's for stop)" },
              ticket_id: { type: "string", description: "attach and stop: the ticket" },
              reason: { type: "string", description: "ignore and stop: why, at most 500 characters" },
              ...ACCEPT_FIELDS,
              tickets: {
                type: "array",
                description: `accept: one entry per part the message names (2–${MAX_SPLIT}), run in parallel unless after; the item's acknowledgement covers all`,
                items: {
                  type: "object",
                  properties: {
                    ...Object.fromEntries(Object.entries(ACCEPT_FIELDS).filter(([k]) => k !== "acknowledgement")),
                    after: { type: "array", items: { type: "string" }, description: "optional: names of entries whose results this one needs; it starts once they ended" },
                  },
                  required: ["title", "name", "type", "scope"],
                },
              },
            },
            required: ["kind", "trigger_id"],
          },
        },
      },
      required: ["decisions"],
    },
    execute: superRoute,
  },
  {
    name: "superagent_eval_decide",
    description: "LLM Superagent: judge an inferred candidate against every enabled rule; accept creates a ticket only in auto mode with a settled direction. Only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        trigger_id: { type: "string" },
        decision: { type: "string", enum: ["accept", "ignore", "unavailable"] },
        rule_assessments: { type: "array", items: { type: "object", properties: { rule_id: { type: "string" }, matched: { type: "boolean" }, reason: { type: "string" } } }, description: "Exactly one entry per enabled rule" },
        direction: {
          type: "object",
          properties: {
            implementation_requested: { type: "boolean" },
            target_basis: { type: "string", enum: ["specified", "existing-standard", "undetermined"] },
            requires_design_decision: { type: "boolean" },
            evidence: { type: "string" },
          },
        },
        intent_evidence: { type: "string", description: "accept: the three facts (this project, change wanted, direction settled) with quotes" },
        reason: { type: "string" },
        ...ACCEPT_FIELDS,
      },
      required: ["trigger_id", "decision", "rule_assessments", "direction"],
    },
    execute: superEvalDecide,
  },
  {
    name: "superagent_reply",
    description: "LLM Superagent: clear a message to the person before posting: result, attention (the ticket's question, exact) or answer; ≤100 words, never twice. Only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        purpose: { type: "string", enum: ["result", "attention", "answer"] },
        ticket_id: { type: "string" },
        trigger_id: { type: "string", description: "answer: the person's question" },
        question: { type: "string", description: "attention: the ticket's question, exactly" },
        text: { type: "string", description: "the message, ≤100 words" },
      },
      required: ["purpose", "text"],
    },
    execute: superReply,
  },
  {
    name: "superagent_ticket",
    description: "LLM Superagent: list, read, report (a returned worker turn), retry, recover, status, note, unsubscribe, requeue, dismiss, merge. Only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "report", "retry", "recover", "status", "note", "unsubscribe", "requeue", "dismiss", "merge"] },
        ticket: { type: "string" },
        turn: { type: "integer", description: "report: the turn number that returned" },
        attempt: { type: "integer", description: "report: the launch item's attempt number" },
        outcome: { type: "string", enum: ["returned", "error"], description: "report: returned, or failed (error, timeout, limit)" },
        error: { type: "string", description: "report: the failure text" },
        failures: { type: "string", description: "report: every `Model … failed (…)` line of the Task result, verbatim, even when the worker then returned" },
        text: { type: "string", description: "report: the sub-agent's reply (fallback when no report file). note: one fact, ≤100 words" },
        model: { type: "string", description: "retry: run on this model instead" },
        thread: { type: "string", description: "unsubscribe: the thread key" },
        trigger_id: { type: "string", description: "requeue: the message" },
        decision: { type: "string", description: "dismiss: the unavailable decision id" },
      },
    },
    execute: superTicket,
  },
];

async function onLoad() {
  let exclude = DEFAULT_EXCLUDE_THINKING;
  let fallbacks = {};
  try {
    const cfg = await settings();
    exclude = cfg.excludeThinking;
    fallbacks = personaFallbacks((await loadCatalog()).entries, cfg);
  } catch {
    // settings unreadable: install with the default exclusions and no fallbacks
  }
  syncPersonas(exclude, fallbacks);
  for (const tool of TOOLS) {
    await pi.agent.registerTool({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      schema: tool.schema,
      execute: (args, ctx) => {
        if (ctx && typeof ctx.log === "function") ctx.log(`${tool.name} called`);
        return serial(() => tool.execute(args, ctx));
      },
    });
    registered.push(tool.name);
  }
}

async function onUnload() {
  for (const name of registered.splice(0)) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      // the host drops plugin tools on unload anyway
    }
  }
  try {
    removePersonas();
  } catch {
    // best effort
  }
}

module.exports = { onLoad, onUnload };
