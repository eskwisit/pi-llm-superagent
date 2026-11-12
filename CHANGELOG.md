# Changelog

## 0.19.0

### Features

- **main:** shorten tool descriptions and schemas to cut prompt tokens (`d381c7d`)
- **main:** refuse a generic acknowledgement (`a7b293c`)
- **main:** register the team tools and workers on the first gateway call (`b32ed80`)
- **subagents:** rename the workers from superagent-worker-* to worker-* (`39c44c6`)
- **skills:** shrink the orchestrator skill to the workflow and the gateway (`1a2eb05`)

### Refactoring

- **subagents:** condense the shared worker instructions (`a0892e2`)

### Documentation

- **readme:** describe the gateway and the worker-* names (`b0dd0bf`)

### Tests

- **lifecycle:** cover the gateway, lazy workers and renamed personas (`4c68e0a`)
- **domain:** refuse a generic acknowledgement (`cedf457`)
- activate the team through the gateway in every setup (`ae25535`)
