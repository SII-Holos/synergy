# Released JSON upgrade fixtures

Each fixture records a published tag, exact commit and the storage/session/message writer schemas used to reconstruct that release's minimal on-disk records. These are schema-derived synthetic fixtures, not copies of private user data. `futureOwner` and the unknown migration owner are deliberate preservation probes added to each fixture.

`released-upgrade.test.ts` starts the real maintenance bootstrap in a separate process and isolated Home. It checks activation, retired JSON removal, migrated message semantics, rebuilt indexes, unknown-field preservation and database relationship verification. Importer tests separately exercise malformed bytes, global corruption, interrupted checkpoints, source drift, read-only files and symbolic links.
