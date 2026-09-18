# Released JSON upgrade fixtures

`agent-v1.sql` is the exact generic Agent table layout from commit `e53d0634f`, before namespace format 2. The SQL upgrade test populates that schema with synthetic records and a deletion tombstone, then verifies reader fencing, preserved revisions and compressed rewrites through the current store.

Each fixture records a published tag, exact commit and the storage/session/message writer schemas used to reconstruct that release's minimal on-disk records. These are schema-derived synthetic fixtures, not copies of private user data. `futureOwner` and the unknown migration owner are deliberate preservation probes added to each fixture.

`released-upgrade.test.ts` starts the real maintenance bootstrap in a separate process and isolated Home. It checks activation, retired JSON removal, migrated message semantics, rebuilt indexes, unknown-field preservation and database relationship verification. Importer tests separately exercise malformed bytes, global corruption, interrupted checkpoints, source drift, read-only files and symbolic links.
