// LLM Superagent guard: while ticket turns run, a Task call must match a launch item.
import fs from "node:fs";
import path from "node:path";

const STATE = path.join(".superagent", "state.json");
const WRITER = "superagent-writer";
const READER = "superagent-reader";
// Mirrors TASK_TYPES in main.js: which worker each ticket type gets.
const AGENT_OF = {
	code: WRITER, debug: WRITER, test: WRITER, docs: WRITER, run: WRITER, merge: WRITER, spec: WRITER,
	research: READER, analysis: READER, review: READER, proof: READER,
};
// Host sub-agents that must never carry a ticket.
const GENERIC = new Set(["explorer", "fixer", "code-reviewer", "test-runner", "ui-designer"]);

// Running turns as launch items: { ticket, turn, agent, model, brief }. [] when the plugin is idle.
function running(cwd) {
	let state;
	try {
		state = JSON.parse(fs.readFileSync(path.join(cwd, STATE), "utf8"));
	} catch {
		return [];
	}
	const out = [];
	for (const t of Object.values(state?.tickets ?? {})) {
		for (const a of t?.assignments ?? []) {
			for (const turn of a?.turns ?? []) {
				if (turn?.state === "running") out.push({ ticket: t.id, turn: turn.n, type: t.type, agent: AGENT_OF[t.type], model: a.model, brief: turn.brief });
			}
		}
	}
	return out;
}

// The running turn a Task call targets: by its description, else by the brief path in its task.
function target(items, input) {
	const m = /^\s*(\S+)\s+#(\d+)\s*$/.exec(String(input.description ?? ""));
	if (m) {
		const hit = items.find((x) => x.ticket === m[1] && String(x.turn) === m[2]);
		if (hit) return hit;
	}
	const task = String(input.task ?? "");
	return items.find((x) => x.brief && task.includes(x.brief)) ?? null;
}

// Null when allowed, else the reason to block.
function judge(items, input) {
	const agent = String(input?.agent ?? "");
	if (GENERIC.has(agent)) {
		return "generic sub-agents never run a ticket; launch the `launch` items the superagent tool returned (agent superagent-writer / superagent-reader).";
	}
	if (agent !== WRITER && agent !== READER) return null;
	const hit = target(items, input);
	if (!hit) {
		const list = items.map((x) => `${x.ticket} #${x.turn} (${x.brief})`).join(", ");
		return `this Task matches no running turn; set description to \`<ticket> #<turn>\` and task to the launch item's task. Running: ${list}.`;
	}
	const id = `${hit.ticket} #${hit.turn}`;
	if (hit.agent && agent !== hit.agent) return `ticket ${hit.ticket} is a ${hit.type} ticket: launch agent ${hit.agent}.`;
	if (hit.model && hit.model !== "inherit" && input.model !== hit.model) {
		return `launch item for ${id} says model ${hit.model}; pass model: "${hit.model}".`;
	}
	if (input.resume) return null;
	if (!hit.brief || !String(input.task ?? "").includes(hit.brief)) {
		return `task must be the launch item's task verbatim: Read your brief at ${hit.brief} in full and follow it.`;
	}
	return null;
}

export default function superagentGuard(pi) {
	pi.on("tool_call", async (event, ctx) => {
		// Fail open: a broken guard must not stop the team.
		try {
			if (String(event?.toolName).toLowerCase() !== "task") return undefined;
			const items = running(ctx?.cwd ?? process.cwd());
			if (!items.length) return undefined;
			const reason = judge(items, event.input ?? {});
			return reason ? { block: true, reason: `LLM Superagent: ${reason}` } : undefined;
		} catch {
			return undefined;
		}
	});
}
