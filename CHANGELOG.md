# Changelog

## 0.21.0

### Features

- add the run task type for read-only parts that share the main checkout (`dcc503e`)
- **subagents:** rename the workers from worker-* to superagent-* (`752433e`)

### Documentation

- **readme:** describe the run task type (`e9146fe`)
- **readme:** use the superagent-* worker names (`eee4bdb`)

### Tests

- **parallel:** cover run tickets sharing the main checkout (`7f489d1`)
- use the superagent-* worker names and cover dropping old copies (`15beb51`)
