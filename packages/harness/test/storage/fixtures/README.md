# Released JSON upgrade fixtures

`agent-v1.sql` is the exact generic Agent table layout from commit `e53d0634f`, before namespace format 2. The SQL upgrade test populates that schema with synthetic records and a deletion tombstone, then verifies reader fencing, preserved revisions and compressed rewrites through the current store.

Each fixture records a published tag, exact commit and the storage/session/message writer schemas used to reconstruct that release's minimal on-disk records. These are schema-derived synthetic fixtures, not copies of private user data. `futureOwner` and the unknown migration owner are deliberate preservation probes added to each fixture.

The 2.0.0 fixture retains the release's `global` Scope, index fields and retired Session booleans. Its quoted `$HOME` token is replaced with the isolated fixture Home before import. The 3.0.21 fixture uses the same minimal user-message/text-part layout as 3.0.22; its release-specific version and source commit remain explicit. All five JSON fixtures run through eager and deferred Harness startup. Full-product upgrades with frozen release completion ledgers live in [Presets fixtures](../../../../presets/test/storage/fixtures/README.md).

`released-upgrade.test.ts` starts the real maintenance bootstrap in a separate process and isolated Home. It checks activation, retired JSON removal, migrated message semantics, rebuilt indexes, unknown-field preservation and database relationship verification. Importer tests separately exercise malformed bytes, global corruption, interrupted checkpoints, source drift, read-only files and symbolic links.
