# Changelog

## 0.8.0

### Features

- **main:** exclude thinking levels, at most medium by default (`76a3095`)

### Documentation

- **skills:** never raise thinking above the suggested level (`23b8a28`)
- **readme:** explain the excludeThinking setting (`9f42e1b`)

### Tests

- cover excluded thinking levels (`84b63f3`)

## 0.7.0

### Features

- **main:** start a split ticket after the tickets whose results it needs (`15dcb0e`)
- **skills:** split parallel parts and a step that needs their results (`be9509a`)

### Documentation

- **readme:** explain tickets that start after others end (`591a906`)

### Tests

- cover tickets that wait for the results of others (`487edd4`)

## 0.5.0

### Features

- **main:** split a message into tickets kept apart by git worktrees (`c2e36fd`)
- **prompts:** allow commits on ticket branches and merge-ticket merges (`ff87e20`)
- **subagents:** set up worktrees and land the branches of merge tickets (`1c5f92b`)
- **skills:** accept split requests and launch merge tickets (`96febee`)

### Documentation

- **readme:** explain parallel tickets, worktrees and merges (`a1eaf87`)

### Tests

- run the lifecycle tests with serial isolation (`eb527a2`)
- cover split tickets, worktree isolation and merge tickets (`c7b2c1e`)

## 0.1.5

### Fixes

- **manifest:** add the chinese name, description and safety notes (`0fbf1fd`)

### Tests

- cover the chinese texts and the apache-2.0 license (`67468c6`)

### Chores

- license the plugin under apache-2.0 (`e068051`)
