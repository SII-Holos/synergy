# Organization Runtime Adapter

Own the Runtime's organization binding, trusted bridge, command receiver, synchronization exporter and remote resource adapters. Identity and project authorization belong to the organization service; this package verifies service identity and execution epochs and preserves actor attribution without maintaining user role tables.

Use Harness execution owners and Inbox; never create another scheduler. Personal configuration, credentials and global Skill sources cannot leak into organization compositions. Keep hosted execution free of native Desktop capabilities and Memory.

Tests live under `test/`. Run `bun run typecheck` and focused tests with isolated Homes, then root dependency and package checks.
