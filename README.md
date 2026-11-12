# LLM Superagent for PI-Desktop

An autonomous team for **any LLM**. Your agent becomes an **orchestrator**: it turns each request
into a **ticket** and hands it to a **worker** sub-agent. Each worker runs on the model, from
**the models you enabled for sub-agents**, that best suits the ticket's **type of task** and its
**requirements**.

> One rule shapes everything: **spend as little of your attention as possible, and give as much
> value as possible.** The orchestrator routes and never does the work itself. Workers run
> unattended. You hear back only for a result, a question only you can answer, or a real
> blocker.

## How it works

```
your message ─► trigger ─┬─► reply on a ticket's thread ─► that ticket's worker (follow-up)
                         └─► gate ─► Eval ─► accept | attach | stop | ignore
                                              │
ticket + mandate ─► assignment ─► turns ─► report ─► handoff (result · question · blocker)
```

| Concept | Here |
|---|---|
| **Source** | The PI-Desktop chat. Each message you send is a **trigger**. |
| **Thread** | A conversation. A new request starts one; replying on a ticket's thread continues it. |
| **Gate** | Allowed senders plus an **admission table**. An addressed request is **explicit**; a message not addressed to the agent is an **inferred** candidate. |
| **Policy** | Accept mode `off` / `observe` (default) / `auto`, rules for proactive work (copy fixes and visual fixes by default), and a version. A change notifies the live tickets it affects. |
| **Eval → Decision** | accept, attach, stop, ignore or unavailable. Every enabled rule is judged for proactive work. Undecided candidates expire and are queued again. |
| **Mandate** | Immutable: strength, scope, policy version and matched rules. It is checked again before an ended ticket resumes. |
| **Ticket** | Open → ended (completed, dropped or stopped). Stages put what needs you first. |
| **Assignment, turns** | One worker session on one model. Each sub-agent run is a turn that ends with a report. |
| **Subscriptions** | Your replies on a ticket's thread reach its worker without a new Eval. A message you send while a worker runs is read in a recheck turn before the ticket can end. Workers hand back what is not theirs, and unread messages are released when a person stops a ticket. |
| **Report, attention** | `progress`, `waiting`, `ready`, `blocked`, `failed` or `dropped`, plus at most one question for you. |
| **Replies** | Checked by purpose (result, attention or answer), at most 100 words, never sent twice. |
| **Parallel work** | One message can start several tickets, one per separate request. A ticket that needs the results of others starts after they end. Workers that change files each work in their own git worktree; a merge worker lands their branches in your checkout. |
| **Slots, recovery** | 3 concurrent workers plus one slot kept for your messages. Retries, status requests, notes, and recovery of turns cut off by a restart. |

## Workers and models

| Type | Worker | The router favours |
|---|---|---|
| `code`, `debug`, `test` | `superagent-code` | coding and reasoning (reasoning first for debug) |
| `research` | `superagent-research` | long context, reasoning, speed |
| `analysis` | `superagent-analysis` | reasoning, context |
| `review` | `superagent-review` | reasoning, coding, and another model family than the work it reviews |
| `docs` | `superagent-docs` | writing |
| `run` | `superagent-code` | speed and low cost: runs tests, builds or linters in the main checkout and reports |

The plugin reads your models itself, through `models.list`, and uses only the ones you enabled
for sub-agents in **Settings > Models**. It infers each model's traits from its id and
capabilities, with no vendor list built in:
- reasoning, coding, writing, context, speed, cheapness and vision;
- the hints it reads: size words, parameter counts, coder variants, reasoning support and
  thinking levels.

Requirements adjust the choice:
- `quality`, `speed`, `budget`, `context`;
- `vision` and `reasoning`, which filter the candidates;
- `differentFrom` a ticket, so a review runs on another model family;
- `prefer` / `avoid`.

Every pick explains itself and comes with fallbacks. **When a model hits a limit** (rate limit,
quota, context window, overload), the ticket fails over to its next model, on another provider
first since limits are per account, with that model's own thinking level. If
no model is enabled for sub-agents, workers run on the session model.

Workers get at most `medium` thinking by default. The `excludeThinking` setting lists the
levels never used (default `high`, `xhigh`, `max`). A higher wanted level goes down to the
next allowed one. Set it to `[]` to allow all levels. A worker runs at the `thinkingLevel` of
its sub-agent definition, so the plugin writes the allowed level into the installed
`superagent-*` files in `~/.agents/subagents` when the `superagent` gateway tool is first called in a session (so idle sessions pay no tokens for them) and after each settings change.
A changed level applies to new sessions. Copies that older releases installed as `worker-*` or
`superagent-worker-*` are removed on that first call; an orchestrator session started before the
update still names the old workers until it restarts.

## Parallel tickets without collisions

A message with several separate requests ("rename the Save button, and add a dark-mode toggle")
starts one ticket per request. They run in parallel, and each worker knows which part is its own.

A message can also ask for parallel parts and then a step that needs their results ("run the
benchmark with tool A and with tool B, then compare the output and the token use"). That starts
one ticket per part and one ticket for the step. The step waits (`after`) until the parts end,
with their branches merged first if they change files. Its brief then points to their reports. A
chain where each step needs the one before it stays one ticket.

A broad request ("ignore AI cost references throughout the project") starts one ticket, because
the orchestrator never reads code. On its first turn, the worker checks how far the request
reaches. When it finds independent parts (for example the API and the web app), it changes
nothing and splits the ticket: one new ticket per part, in parallel, under the same request,
with an optional step that waits for them (`after`). Each part names its type of task (code,
test, docs, review, …) and may carry its own requirements (`quality=low`, `speed=high`,
`reasoning=true`, …), so it gets the worker and model that fit it. A part may split once more;
all parts of one request are merged together.

Workers that change files (`code`, `debug`, `test`, `docs`) never share a checkout:

1. Each worker makes its own git worktree, `.superagent/worktrees/<ticket>`, on a local branch
   `superagent/<ticket>`. The branch starts from your current state, including your uncommitted
   changes. The worker builds, tests and commits only there.
2. When a worker reports `ready`, its branch waits for a **merge ticket**. The merge worker lands
   the branches in your checkout, one merge at a time, resolves conflicts so that every ticket's
   intent stays, runs the checks on the combined result, and removes the worktrees. Tickets from
   the same message are merged together.
3. You get one result message for the merge. The changes stay uncommitted in your working tree
   unless your request or the Delivery requirements ask for a commit. Nothing is pushed.

The plugin looks for `.git` in the workspace root, or in the ticket's `repo` folder, and runs
writers in parallel as soon as it finds one. When the workspace holds several projects that are
each their own git repository (for example `~/Code/pi/neural-radar`), the orchestrator sets `repo`
on the ticket: the worktrees, branches and merge then belong to that repository, and writers in
different project folders never wait for each other. Without git found, workers that change files
run one at a time in that checkout until a worker confirms git. Read-only workers (`research`,
`analysis`, `review`) always run in parallel; a review can read a ticket's branch before it is
merged. `run` workers (tests, builds, linters) share the main checkout and run side by side; a
merge or a worker that changes that checkout waits until they finish, and they wait for it. Set
`isolation` to `worktree` to use worktrees from the first ticket, or to `serial` to never use them.

## Checked work: acceptance tests, proof, fixes

Workers that change code are checked before their work reaches you, as a small team per request:

```
spec (acceptance tests) ─┐
worker(s) ───────────────┴─► proof ─fail─► defects back to their worker ─► proof … ─pass─► merge
```

- A **test worker** writes an acceptance checklist and tests from your request alone, while the
  workers implement it. It never sees their code, so its tests catch what they missed.
- When all of them are ready, a **proof worker** on another model family combines their branches in
  a scratch worktree. It runs the acceptance tests and the project's own checks (**quality**). It
  also reads the diffs for **coherence**: the change does what you asked and nothing else, follows
  the code around it, the parts fit together, and nothing is left behind (debug output, stubs,
  skipped tests).
- Each defect goes back to the worker that owns it as a fix turn. A wrong acceptance test goes back
  to the test worker. The proof runs again on the fixed work.
- When the proof passes, the branches (with the tests) go to the merge. After `proofRounds` failed
  rounds (default 3), the branches stay unmerged and you decide.

To keep the token cost small, the test worker runs on a cheap model at low thinking, and the
tickets of one message share one test worker and one proof. The orchestrator sets `check` per
ticket: `full` (default for code and debug), `proof` (default for tests), or `none` for trivial
changes and docs. `proofRounds: 0` turns checks off.

## Model limits

A rate limit or quota holds for a whole provider account, so the plugin handles it once for all
tickets:

- The worker definitions carry `fallbackModels`: one model per other account, best first. When a
  worker hits a limit, PI-Desktop moves it to the next one in the same session, with its work so
  far. PI-Desktop first retries the limited model, which can take a few minutes.
- When a worker fails on a limit, or the host reports that it moved away from a limited model,
  the plugin cools that account for 15 minutes. No ticket starts on it during that time: every
  launch goes to the ticket's next model on a healthy account at once. A context-window limit
  only moves that one ticket.

## Usage

In a workspace, say for example:

> Superagent: the login times out after the last deploy, fix it.

The orchestrator records the message, accepts it as a `debug` ticket, acknowledges it in one
sentence, and launches the code worker on your strongest coding model. Then:

- **Answer** a worker's question: your reply goes to that ticket.
- **"status":** what needs you comes first.
- **"stop the login ticket":** stopped for good.
- **"review the login fix":** a `review` ticket on another model family.
- **"auto-accept typo fixes":** the accept mode set to `auto` for the copy rule.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `policy` | observe; rules copy and visual; allowed `person` | accept mode, rules, allowed senders, admission |
| `maxWorkers` | `6` | worker turns at once, plus one slot for you |
| `proofRounds` | `3` | failed proof rounds before you decide; `0` turns checks off |
| `evalTimeoutSeconds` | `120` | how long a candidate waits for a decision |
| `paused` | `false` | record messages but evaluate, launch and send nothing |
| `isolation` | `auto` | `auto`, `worktree` or `serial`: how workers that change files avoid collisions |
| `roleModels` | `{}` | pinned models per task type |
| `modelProfiles` | `{}` | corrections to inferred traits |
| `excludeModels`, `modelNotes` | `[]` | models never used; notes for the orchestrator |
| `excludeThinking` | `["high", "xhigh", "max"]` | thinking levels workers never get |
| `communication`, `ticketScope`, `delivery` | built-in | team sections every worker reads |

## Safety

- File access through the host API is limited to `.superagent/**` in the workspace.
- `models.list` shows the plugin which models you enabled, never any key.
- Only the `superagent` gateway tool is registered at load. Its first call registers the seven
  team tools and copies the five worker personas with Node `fs` to `~/.agents/subagents`, which
  is where PI-Desktop loads sub-agents from. Unload removes them, unless you edited them.
- The plugin has no network access and runs no processes. Workers are ordinary PI-Desktop
  sub-agents:
  - the code and docs workers can edit workspace files;
  - every worker can run shell commands (the docs worker uses them only for git);
  - workers that change files create git worktrees under `.superagent/worktrees` and local
    `superagent/<ticket>` branches, and the merge worker removes them after it lands them.

  They do so with the permissions PI-Desktop grants sub-agents. Apart from commits on their own
  ticket branches and the merge into your working tree, they never commit, push, publish or
  merge unless your request or the Delivery requirements say so.

## Development

```sh
node --test tests/
```

## Credits

The domain model, the authorization flow and the working rules follow the design of
[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
by the DeepSeek Harness Team, a research prototype of a proactive coding agent, adapted here to
PI-Desktop with the chat as its Source. All prompt text in this plugin is original.

## License

[Apache-2.0](LICENSE)
