# MEMORY

## Done
- 2026-11-12: cut prompt footprint: one `superagent` tool with operation keys (was 8 tools), two personas writer/reader (was 5), role rules per ticket type in prompts/roles, shorter team sections and skill; idle ~400 → ~150 tok

## Gotchas
- Tools registered mid-turn are invisible to ToolSearch until the next prompt: register everything at load
- Host reads thinkingLevel/fallbackModels only from persona files, so personas can't be merged below the write/read split without losing per-role thinking
- Tests call `superagent_<op>`; tests/helpers.js maps that to `superagent({ op: args })`

## Decisions
- Role-specific worker guidance lives in the brief (prompts/roles/<role>.md), not the persona, so each worker reads only its own role
- Merge and proof tickets name no role; their briefs carry their own procedure
