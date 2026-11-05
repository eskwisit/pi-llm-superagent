# Changelog

## 0.1.4

### Fixes

- **main:** read messages sent during a turn before a ticket ends (`cae78c8`)
- **main:** fail over to another provider when a model hits a limit (`9da6533`)
- **main:** suggest the thinking level of the model a turn runs on (`c4f20b1`)
- **main:** rate local models up to 40b as small, not mid-tier (`f947fa2`)

### Tests

- cover recheck turns, provider failover and per-model thinking (`82cd9fd`)
- cover the tier of small local models (`9cedfef`)
