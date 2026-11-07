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
| `code`, `debug`, `test` | `superagent-worker-code` | coding and reasoning (reasoning first for debug) |
| `research` | `superagent-worker-research` | long context, reasoning, speed |
| `analysis` | `superagent-worker-analysis` | reasoning, context |
| `review` | `superagent-worker-review` | reasoning, coding, and another model family than the work it reviews |
| `docs` | `superagent-worker-docs` | writing |

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
next allowed one. Set it to `[]` to allow all levels.

## Parallel tickets without collisions

A message with several separate requests ("rename the Save button, and add a dark-mode toggle")
starts one ticket per request. They run in parallel, and each worker knows which part is its own.

A message can also ask for parallel parts and then a step that needs their results ("run the
benchmark with tool A and with tool B, then compare the output and the token use"). That starts
one ticket per part and one ticket for the step. The step waits (`after`) until the parts end,
with their branches merged first if they change files. Its brief then points to their reports. A
chain where each step needs the one before it stays one ticket.

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

Until a worker confirms that the workspace is a git repository, and always in a workspace without
git, workers that change files run one at a time in your checkout. Read-only workers (`research`,
`analysis`, `review`) always run in parallel; a review can read a ticket's branch before it is
merged. Set `isolation` to `worktree` to use worktrees from the first ticket, or to `serial` to
never use them.

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
| `maxWorkers` | `3` | worker turns at once, plus one slot for you |
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
- On load, Node `fs` copies the five worker personas to `~/.agents/subagents`, which is where
  PI-Desktop loads sub-agents from. Unload removes them, unless you edited them.
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
