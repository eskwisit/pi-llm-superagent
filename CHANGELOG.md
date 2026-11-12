# Changelog

## 0.23.0

### Features

- two workers, writer and reader, with the role rules in each brief (`325277e`)
- one superagent tool with operation keys replaces the eight tools (`d964ab2`)

### Fixes

- register all eight tools at load so ToolSearch finds them (`970c0d7`)

### Performance

- **subagents:** shorten the worker personas by a quarter (`ea6bd8e`)
- **prompts:** shorten the default team sections (`3e8dfea`)

### Documentation

- **readme:** describe the eight tools registered at load (`3d5fb79`)
- **readme:** describe the one tool and the two workers (`0a3f779`)
- add project memory (`9a37d50`)

### Tests

- **lifecycle:** cover the eight tools at load and the activation queries (`3c9a3dc`)
