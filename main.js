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
 *   superagent_ticket       list | read | report | retry | status | note | unsubscribe | requeue | dismiss
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

const TASK_TYPES = {
  code: { agent: "superagent-worker-code", weights: { coding: 5, reasoning: 3, context: 2 }, thinking: "medium", about: "implement a change: feature, fix, refactor" },
  debug: { agent: "superagent-worker-code", weights: { coding: 4, reasoning: 5, context: 2 }, thinking: "high", about: "find and fix the root cause of a failure" },
  test: { agent: "superagent-worker-code", weights: { coding: 4, reasoning: 2, speed: 2, cost: 1 }, thinking: "medium", about: "write or repair tests" },
  research: { agent: "superagent-worker-research", weights: { reasoning: 3, context: 4, speed: 2, cost: 1 }, thinking: "medium", about: "investigate code, docs or behaviour and answer with evidence; read-only" },
  analysis: { agent: "superagent-worker-analysis", weights: { reasoning: 5, context: 3, coding: 1 }, thinking: "high", about: "design, tradeoff, data or root-cause analysis; read-only" },
  review: { agent: "superagent-worker-review", weights: { reasoning: 5, coding: 3, context: 3 }, thinking: "high", about: "review a change or another ticket's result for defects; read-only" },
  docs: { agent: "superagent-worker-docs", weights: { writing: 5, reasoning: 2, context: 2 }, thinking: "low", about: "write or update documentation and prose" },
};
const AGENTS = [...new Set(Object.values(TASK_TYPES).map((t) => t.agent))];
const MARKER = "Use only from the llm-superagent skill.";

const SOURCE = "chat";
const PERSON = "person";
const ROOT_DIR = ".superagent";
const STATE_FILE = `${ROOT_DIR}/state.json`;
const RULE_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const REPORT_STATES = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];
const LIMIT = /\b429\b|rate.?limit|quota|usage.?limit|limit (reached|exceeded|hit)|too many requests|context.?(length|window)|maximum context|token limit|overload|capacity|insufficient.?(credit|balance|funds)/i;
const TRANSIENT = /\b(408|5\d\d)\b|timed? ?out|timeout|ECONN|ETIMEDOUT|socket|network|temporar|unavailable|connection (reset|refused)/i;
const TURN_RETRIES = 3; // attempts of one turn after passing failures
const GO_ON_LIMIT = 2; // turns that may end in `progress` in a row before the ticket idles
const STALE_TURN_MS = 90 * 60 * 1000; // a turn running longer was cut off (workers stop at 60 min)
const MAX_FALLBACKS = 3;
const NOTE_WORDS = 30; // routing note
const IM_WORDS = 100; // any message to the person
const NOTE_FACT_WORDS = 100; // a note about other work
const DEFAULT_WORKERS = 3;
const MAX_WORKERS = 8;
const DEFAULT_EVAL_TIMEOUT = 120;

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

  let tier = "mid";
  if (has("nano", "lite", "tiny", "micro") || (size !== null && size <= 4)) tier = "tiny";
  else if (has("haiku", "flash", "mini", "small", "instant", "air", "fast") || (size !== null && size <= 14)) tier = "small";
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
  const levels = /thinking\s*:\s*([a-z/ ,]+)/.exec(d);
  if (levels) p.thinking = THINKING.filter((l) => levels[1].split(/[\s/,]+/).includes(l));
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

/** Pick the suggested thinking level the model supports, closest to the wanted one. */
function thinkingFor(type, req, p) {
  let want = req.thinking;
  if (!want) {
    const i = THINKING.indexOf(TASK_TYPES[type].thinking);
    const bump = { low: -1, normal: 0, high: 1, max: 9 }[req.quality || "normal"];
    want = THINKING[Math.max(0, Math.min(THINKING.length - 1, i + bump))];
  }
  if (!p || !p.thinking.length) return p && p.reasoningModel ? want : null;
  const wi = THINKING.indexOf(want);
  const below = p.thinking.filter((l) => THINKING.indexOf(l) <= wi);
  return below.length ? below[below.length - 1] : p.thinking[0];
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
    return { model: "inherit", fallbacks: [], thinking: thinkingFor(type, req, null), score: null, why: "no delegation catalog: run on the session model", candidates: [], warnings };
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
    thinking: thinkingFor(type, req, p),
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
    policy: {
      mode: MODES.includes(policy.mode) ? policy.mode : "observe",
      rules: rules.map((r) => ({ id: str(r.id), name: str(r.name) || str(r.id), enabled: r.enabled !== false, instruction: str(r.instruction).trim() })),
      sources: { [SOURCE]: { allowed: allowed.map((a) => ({ id: str(a.id).trim(), ...(a.name ? { name: str(a.name) } : {}) })), admission: { [SOURCE]: admission } } },
    },
    evalTimeoutSeconds: Number.isInteger(t) && t >= 30 && t <= 3600 ? t : DEFAULT_EVAL_TIMEOUT,
    maxWorkers: Number.isInteger(n) && n >= 1 && n <= MAX_WORKERS ? n : DEFAULT_WORKERS,
    profiles: isObj(s.modelProfiles) ? s.modelProfiles : {},
    pins: isObj(s.roleModels) ? s.roleModels : {},
    exclude: strList(s.excludeModels),
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
    description: [m.providerName, m.alias, m.supportsReasoning ? "reasoning" : "", Array.isArray(m.thinkingLevels) && m.thinkingLevels.length ? `thinking: ${m.thinkingLevels.join("/")}` : ""].filter(Boolean).join(", "),
  })));
  const note = entries.length ? null : models.length
    ? "none of your models is enabled for sub-agents (Settings > Models); workers run on the session model"
    : "no signed-in models found; workers run on the session model";
  return { entries, note };
}

function routingContext(entries, cfg) {
  const profiles = new Map(entries.map((e) => [e.id, profileOf(e, cfg.profiles)]));
  return { entries, profiles, exclude: cfg.exclude, pins: cfg.pins, chosen: new Map() };
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
  if (report === "ready") return { stage: "person", action: "review" };
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

/** Schedule a turn for what waits on the ticket. A held ticket (blocked or failed) wakes only for a person's message. */
function wake(state, t, { priority = false, kind = "work" } = {}) {
  if (!liveTicket(t)) return;
  if (kind === "work" && !t.undelivered.length && t.assignments.length) return;
  if (kind === "work" && waitsForPerson(t)) return;
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

/** Launch pending turns into free slots, people's messages first; one extra slot is kept for a person or a status request. */
async function promote(state, cfg, out) {
  if (cfg.paused) return;
  const pending = [];
  let running = 0;
  let extraUsed = false;
  for (const t of Object.values(state.tickets)) {
    if (!liveTicket(t)) continue;
    for (const a of t.assignments) {
      for (const turn of a.turns) {
        if (turn.state === "running") {
          running++;
          if (turn.extra) extraUsed = true;
        } else if (turn.state === "pending" && a.state !== "ended") pending.push([t, a, turn]);
      }
    }
  }
  pending.sort((x, y) => Number(y[2].priority) - Number(x[2].priority) || x[2].seq - y[2].seq);
  for (const [t, a, turn] of pending) {
    let extra = false;
    if (running - (extraUsed ? 1 : 0) >= cfg.maxWorkers) {
      if (!turn.priority || extraUsed) continue;
      extra = true;
      extraUsed = true;
    }
    running++;
    turn.inputs = t.undelivered.splice(0);
    for (const id of turn.inputs) Object.assign(t.inputs.find((i) => i.id === id), { deliveredTo: a.id, turn: turn.n });
    Object.assign(turn, { state: "running", startedAt: now(), extra });
    if (a.state === "pending") Object.assign(a, { state: "running", startedAt: now() });
    await pi.fs.writeText(turn.brief, buildBrief(state, cfg, t, a, turn));
    out.launch.push(launchItem(t, a, turn));
  }
  out.queued = pending.filter(([, , turn]) => turn.state === "pending").map(([t, , turn]) => `${t.id}#${turn.n}`);
}

function launchItem(t, a, turn) {
  return {
    ticket: t.id, turn: turn.n, attempt: (turn.attempts || 0) + 1, agent: TASK_TYPES[t.type].agent, model: a.model, thinking: t.thinking,
    task: `Read your brief at ${turn.brief} in full and follow it.`, report: turn.report,
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
    : turn.kind === "go-on"
      ? "\n**Go on.** Your previous turn ended while the work was still in progress. Continue from where it stopped.\n"
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
${rules.length ? `\nThis ticket was accepted proactively under these rules. Your authority is limited to the accepted change within them; recheck that it was really requested, that its target is settled, and that no design decision is open, before you change anything:\n\n${rules.map((r) => `- ${r.name} (${r.id}): ${r.instruction}`).join("\n")}\n` : ""}
## Inputs

${shown.length ? `Everything that reached this ticket after it started, oldest first. NEW marks what you have not seen in an earlier turn. Decide every NEW message from a person yourself: take it up when it is within this ticket, or hand it back with a reason.\n\n${shown.map((i) => inputLine(state, i, fresh.has(i.id))).join("\n\n")}` : "(none)"}

## Earlier turns

${reports.length ? `Read the latest report before you start, and check the workspace before you repeat any action.\n\n${reports.join("\n")}` : "(none: this is the first turn)"}
${a.recovery ? `\n## Recovery note\n\n${a.recovery}\n` : ""}
${team}

## Report

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
---
<full evidence: what changed (files), checks actually run and their results, risks, what remains>
\`\`\`

Then reply with only the state line.
`;
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

function installPersonas() {
  const src = personaSource();
  const dst = personaTarget();
  const wanted = new Set(AGENTS.map((a) => `${a}.md`));
  fs.mkdirSync(dst, { recursive: true });
  const changed = [];
  for (const name of wanted) {
    const body = fs.readFileSync(path.join(src, name));
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

/** Remove the personas this plugin installed, unless the user edited them. */
function removePersonas() {
  for (const a of AGENTS) {
    const name = `${a}.md`;
    try {
      if (fs.readFileSync(path.join(personaTarget(), name)).equals(fs.readFileSync(path.join(personaSource(), name)))) {
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
function uniqueTicketId(state, base) {
  if (!state.tickets[base]) return base;
  for (let i = 2; ; i++) if (!state.tickets[`${base}-${i}`]) return `${base}-${i}`;
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

/** Accept: a ticket with its Mandate, subscribed to the batch's threads, its model picked by type and requirements. */
function createTicket(state, cfg, catalog, thread, ev, fields, out) {
  const earlier = Object.values(state.tickets).find((x) => x.origin.triggerIds.includes(ev.primary));
  if (earlier) fail(`message ${ev.primary} already started ticket ${earlier.id}; attach to it or ignore`);
  const type = str(fields.type).trim();
  if (!TASK_TYPES[type]) fail(`type must be one of ${Object.keys(TASK_TYPES).join(", ")}`);
  const title = str(fields.title).trim();
  if (!title || title.length > 200) fail("title is required: a short label of the original request, at most 200 characters");
  const note = str(fields.note).trim();
  checkWords(note, NOTE_WORDS, "the routing note");
  const ack = str(fields.acknowledgement).trim();
  if (fields.requireAck && !ack) fail("acknowledgement is required: one short sentence naming the concrete change and its intended result");
  checkWords(ack, IM_WORDS, "the acknowledgement");
  const { req, warnings } = normalizeRequirements(fields.requirements, "requirements");
  out.warnings.push(...warnings);
  const id = uniqueTicketId(state, slug(fields.name || title));
  const ctx = routingContext(catalog.entries, cfg);
  for (const t of Object.values(state.tickets)) ctx.chosen.set(t.id, t.model);
  const route = routeTask({ id, type, req }, ctx);
  out.warnings.push(...route.warnings);
  const mandate = {
    strength: ev.strength, policyVersion: ev.policyVersion,
    basis: { ...ev.basis, ...(fields.rules ? { rules: fields.rules } : {}) },
    actor: ev.actor, scope: str(fields.scope).trim() || title,
  };
  const t = {
    id, title, type, decisionId: null, mandate, channels: [thread.key], attention: undefined, assignments: [], inputs: [],
    undelivered: [], answers: [], createdAt: now(), updatedAt: now(), origin: { triggerId: ev.primary, triggerIds: ev.triggerIds },
    note, req, model: route.model, chain: [route.model, ...route.fallbacks], why: route.why, thinking: route.thinking,
  };
  state.tickets[id] = t;
  for (const trId of [ev.primary, ...ev.triggerIds.filter((x) => x !== ev.primary)]) {
    const tr = state.triggers[trId];
    for (const key of tr.threads) if (!state.threads[key].subscriptions.includes(id)) state.threads[key].subscriptions.push(id);
    state.dispositions[trId].fanout.push(id);
    addInput(state, t, { kind: "trigger", triggerId: trId, human: tr.human, at: tr.at });
  }
  wake(state, t); // a new launch waits for a normal slot; the extra one is kept for a person's message
  const decision = recordDecision(state, cfg, thread, ev, { kind: "accept", ticketId: id, mandate, reason: [{ code: "accepted", text: str(fields.reason) }], ...(fields.audit ? { audit: fields.audit } : {}) }, out);
  t.decisionId = decision.id;
  const post = [];
  if (ack) {
    const rid = `ack:${ev.primary}`;
    if (!state.outbox.some((r) => r.id === rid)) state.outbox.push({ id: rid, purpose: "acknowledgement", ticketId: id, triggerId: ev.primary, text: ack, at: now() });
    post.push(ack);
  }
  return { ticket: id, decision: decision.id, agent: TASK_TYPES[type].agent, model: route.model, fallbacks: route.fallbacks, thinking: route.thinking, why: route.why, ...(post.length ? { post: post[0] } : {}) };
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
    if (a.maxWorkers !== undefined) {
      if (!Number.isInteger(a.maxWorkers) || a.maxWorkers < 1 || a.maxWorkers > MAX_WORKERS) fail(`maxWorkers must be an integer from 1 to ${MAX_WORKERS}`);
      patch.maxWorkers = a.maxWorkers;
    }
    if (a.evalTimeoutSeconds !== undefined) {
      if (!Number.isInteger(a.evalTimeoutSeconds) || a.evalTimeoutSeconds < 30 || a.evalTimeoutSeconds > 3600) fail("evalTimeoutSeconds must be an integer from 30 to 3600");
      patch.evalTimeoutSeconds = a.evalTimeoutSeconds;
    }
    if (a.paused !== undefined) patch.paused = a.paused === true;
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
      paused: cfg.paused, maxWorkers: cfg.maxWorkers, evalTimeoutSeconds: cfg.evalTimeoutSeconds,
      roleModels: cfg.pins, overrides: cfg.profiles, exclude: cfg.exclude, notes: cfg.notes,
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
      const ready = outcome === "completed" || outcome === "dropped" || (t && liveTicket(t) && latestAssignment(t) && latestAssignment(t).report && latestAssignment(t).report.state === "ready");
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
    const nextModel = t.chain[t.chain.indexOf(t.model) + 1];
    if (limit && nextModel) {
      const from = t.model;
      t.model = nextModel;
      restartAssignment(state, t, `Turn ${n} on ${from} hit a limit (${reason}). It may have changed files: check the workspace and any earlier report before you repeat an action.`, "model limit");
      return { ticket: t.id, stage: stageLabel(t), note: `limit on ${from}: failed over to ${nextModel}`, handoff: { kind: "none" } };
    }
    if ((transient || limit) && turn.attempts + 1 < TURN_RETRIES) {
      turn.attempts++;
      turn.startedAt = now();
      out.launch.push(launchItem(t, asg, turn));
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
  if (rep.state === "ready") endTicket(state, cfg, t, { by: "executor", outcome: "completed" }, out);
  else if (rep.state === "dropped") endTicket(state, cfg, t, { by: "executor", outcome: "dropped" }, out);
  const human = t.undelivered.some((id) => {
    const i = t.inputs.find((x) => x.id === id);
    return i && i.kind === "trigger" && i.human && !i.context;
  });
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
  return { ticket: t.id, stage: stageLabel(t), handoff: handoffFor(t, rep), ...(answer ? { answer } : {}), ...(handbacks.length ? { handbacks } : {}) };
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
    return fail("action must be one of list, read, report, retry, recover, status, note, unsubscribe, requeue, dismiss");
  });
}

/** The overview: what waits for a person first, then working, queued and idle tickets; a healthy state takes no space. */
function ticketList(state, cfg) {
  const order = ["person/answer", "person/review", "person/blocked", "person/failed", "working", "working/queued", "idle"];
  const line = (t) => `${t.id} [${stageLabel(t)}] ${t.type} on ${t.model}: ${t.title}${t.attention ? ` · asks: ${t.attention.question}` : ""}`;
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
  description: "Optional: quality low|normal|high|max, speed low|normal|high, budget low|normal|high, context short|normal|long|huge, vision bool, reasoning bool, thinking level, differentFrom [ticket ids whose model family to avoid], prefer [globs], avoid [globs]",
};
const TYPES = Object.keys(TASK_TYPES);
const ACCEPT_FIELDS = {
  title: { type: "string", description: "accept: a short label of the original request, at most 200 characters; no added requirements" },
  name: { type: "string", description: "accept: a short English name; it becomes the ticket id" },
  acknowledgement: { type: "string", description: `accept: one short sentence, at most ${IM_WORDS} words, naming the concrete change and intended result, in the person's language` },
  note: { type: "string", description: `accept and attach: optional routing background or an explicit constraint of the person, at most ${NOTE_WORDS} words; never instructions` },
  type: { type: "string", enum: TYPES, description: "accept: the type of task, which picks the worker and its model" },
  requirements: REQ_SCHEMA,
  scope: { type: "string", description: "accept: one sentence naming the work the mandate allows; defaults to the title" },
};

const TOOLS = [
  {
    name: "superagent_config",
    description: "LLM Superagent: read or save the policy (accept mode, rules, allowed senders, admission), worker slots, eval timeout, pause, role models per task type, model trait overrides, exclusions and team sections; shows your sub-agent models with their inferred traits. Use only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"] },
        mode: { type: "string", enum: MODES, description: "set: accept mode for proactive (inferred) candidates" },
        rules: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" }, instruction: { type: "string" } } }, description: "set: the full rule list" },
        allowed: { type: "array", items: { type: "string" }, description: "set: sender ids allowed to request work (default [\"person\"])" },
        admission: { type: "object", description: "set: { listedUnaddressed: inferred|ignore, unlistedAddressed: explicit|inferred|ignore, unlistedUnaddressed: inferred|ignore }" },
        maxWorkers: { type: "integer", description: `set: concurrent worker turns, 1–${MAX_WORKERS} (default ${DEFAULT_WORKERS}); one extra slot is kept for a person's message` },
        evalTimeoutSeconds: { type: "integer", description: `set: how long a candidate waits for a decision, 30–3600 (default ${DEFAULT_EVAL_TIMEOUT})` },
        paused: { type: "boolean", description: "set: pause or resume processing (evals, launches, replies); messages are still recorded" },
        roleModels: { type: "object", description: "set: { taskType: [model, fallback, …] } pins; [] removes a pin" },
        profiles: { type: "object", description: "set: { glob: { reasoning|coding|writing|context|speed|cost: 1-5, vision|reasoningModel|unstable: bool, thinking: [levels] } }; null removes" },
        exclude: { type: "array", items: { type: "string" }, description: "set: model id globs never to use" },
        include: { type: "array", items: { type: "string" }, description: "set: exclusion globs to remove" },
        notes: { type: "array", items: { type: "string" } },
        team: { type: "object", description: "set: { communication|scope|delivery: text }; \"\" restores the default" },
        show: { type: "array", items: { type: "string" }, description: "get: team sections to return in full" },
        clear: { type: "boolean", description: "set: forget role models, overrides, exclusions and notes first" },
      },
    },
    execute: superConfig,
  },
  {
    name: "superagent_models",
    description: "LLM Superagent: preview which of your sub-agent models (with fallbacks and suggested thinking level) a task type and requirements would get. Use only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string", enum: TYPES }, requirements: REQ_SCHEMA }, required: ["type"] } },
        explain: { type: "boolean", description: "Also return the top 5 candidates with scores" },
      },
      required: ["tasks"],
    },
    execute: superModels,
  },
  {
    name: "superagent_intake",
    description: "LLM Superagent: record a person's chat message as a trigger. A reply on a ticket's thread goes straight to that ticket's worker (follow-up); anything else goes through the gate to Eval and comes back as a candidate card. Use only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The person's message, verbatim" },
        addressed: { type: "boolean", description: "false when the message is not addressed to you as a request (shared material, an aside, thinking aloud); default true" },
        thread: { type: "string", description: "Only when the message replies within an existing thread (answers a ticket's question, or follows up on its result): that thread key" },
      },
      required: ["text"],
    },
    execute: superIntake,
  },
  {
    name: "superagent_route",
    description: "LLM Superagent: decide waiting candidates, one item each: accept (new ticket, explicit requests only), attach (to a ticket the message points at), stop (a ticket, at the person's request) or ignore (with a reason). Items are processed independently. Use only from the llm-superagent skill.",
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
              trigger_id: { type: "string", description: "The candidate card's trigger_id (a follow-up's for stop)" },
              ticket_id: { type: "string", description: "attach and stop: the ticket" },
              reason: { type: "string", description: "ignore and stop: why, at most 500 characters" },
              ...ACCEPT_FIELDS,
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
    description: "LLM Superagent: record the assessment of a proactive (inferred) candidate against every enabled rule; accept creates a ticket only in auto mode and only with a settled direction and a matched rule. Use only from the llm-superagent skill.",
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
        intent_evidence: { type: "string", description: "accept: the three facts (this project, a change is wanted, direction settled) with source quotes" },
        reason: { type: "string" },
        ...ACCEPT_FIELDS,
      },
      required: ["trigger_id", "decision", "rule_assessments", "direction"],
    },
    execute: superEvalDecide,
  },
  {
    name: "superagent_reply",
    description: "LLM Superagent: clear a message to the person by its purpose before you post it: result (a ready, completed or dropped ticket), attention (the ticket's open question, copied exactly) or answer (a question the worker answered); at most 100 words, never twice. Use only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        purpose: { type: "string", enum: ["result", "attention", "answer"] },
        ticket_id: { type: "string" },
        trigger_id: { type: "string", description: "answer: the person's question" },
        question: { type: "string", description: "attention: the ticket's open question, exactly" },
        text: { type: "string", description: "The message, at most 100 words" },
      },
      required: ["purpose", "text"],
    },
    execute: superReply,
  },
  {
    name: "superagent_ticket",
    description: "LLM Superagent: list (what needs the person first), read, report (record a worker turn when its sub-agent returns), retry, recover (a turn lost to a restart), status, note, unsubscribe (a thread), requeue (a message to Eval), dismiss (an unavailable decision). Use only from the llm-superagent skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "report", "retry", "recover", "status", "note", "unsubscribe", "requeue", "dismiss"] },
        ticket: { type: "string" },
        turn: { type: "integer", description: "report: the turn number that returned" },
        attempt: { type: "integer", description: "report: the launch item's attempt number" },
        outcome: { type: "string", enum: ["returned", "error"], description: "report: the sub-agent returned, or failed (error, timeout, limit)" },
        error: { type: "string", description: "report: the failure text" },
        text: { type: "string", description: "report: the sub-agent's reply, used only when it wrote no report file. note: one fact from other work, at most 100 words" },
        model: { type: "string", description: "retry: run on this model instead (a new worker session)" },
        thread: { type: "string", description: "unsubscribe: the thread key" },
        trigger_id: { type: "string", description: "requeue: the message" },
        decision: { type: "string", description: "dismiss: the unavailable decision id" },
      },
    },
    execute: superTicket,
  },
];

async function onLoad() {
  try {
    const changed = installPersonas();
    personaStatus = changed.length ? `installed or updated: ${changed.join(", ")}` : "installed and up to date";
  } catch (e) {
    personaStatus = `could not install to ${personaTarget()}: ${e && e.message}`;
  }
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
