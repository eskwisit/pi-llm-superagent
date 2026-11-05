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
| `roleModels` | `{}` | pinned models per task type |
| `modelProfiles` | `{}` | corrections to inferred traits |
| `excludeModels`, `modelNotes` | `[]` | models never used; notes for the orchestrator |
| `communication`, `ticketScope`, `delivery` | built-in | team sections every worker reads |

## Safety

- File access through the host API is limited to `.superagent/**` in the workspace.
- `models.list` shows the plugin which models you enabled, never any key.
- On load, Node `fs` copies the five worker personas to `~/.agents/subagents`, which is where
  PI-Desktop loads sub-agents from. Unload removes them, unless you edited them.
- The plugin has no network access and runs no processes. Workers are ordinary PI-Desktop
  sub-agents:
  - the code and docs workers can edit workspace files;
  - the code, research, analysis and review workers can run shell commands.

  They do so with the permissions PI-Desktop grants sub-agents. They never commit, push,
  publish or merge unless your request or the Delivery requirements say so.

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

[MIT](LICENSE)
