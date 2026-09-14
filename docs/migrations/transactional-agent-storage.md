# Transactional Agent Storage Upgrade

## Upgrade

Stop the instance through its normal user-facing shutdown flow before running offline maintenance. The next Runtime startup, or `synergy data storage resume`, acquires exclusive Home ownership, backs up original data and configuration, imports legacy records, runs the installed domain migrations and activates SQL authority. Never run an old binary against an activated Home.

The immutable backup is `data/storage/backups/<backup-id>/`. Its `manifest.json` records the source identity, file count, bytes and inventory checksum. `inventory.ndjson` records every original path, content hash, size and symbolic-link target. Original data is under `data/`; `data/@home/config/` and `data/@home/plugin.lock` preserve Home-level inputs. Workspace symbolic links are preserved as links and never traversed. Authoritative record links are rejected.

Before copying, bootstrap estimates space for the immutable backup, records and database overhead; insufficient free space stops the import. Corrupt global Scope or migration-ledger records block activation even on repeated resume.

Repeated `resume` uses recorded checkpoints and the same sealed backup. It rejects changed source files, missing backup bytes and identity mismatches. A record with invalid historical JSON is preserved in the backup and assigned a persistent recovery issue. Affected Sessions cannot execute until their evidence is repaired and their block is resolved. Do not delete a recovery marker merely to bypass a failed upgrade.

## Verify and troubleshoot

`data storage status` reports the active backend, namespace, database/artifact identity, recovery records and outstanding notifications. `data storage verify` reads database integrity and record relationships without modifying data and returns a failing exit code for reported issues. Storage I/O, authorization, ownership and malformed engine/configuration errors remain fatal rather than becoming empty data.

If an upgrade is interrupted, preserve the entire Home, correct the reported cause and run `resume`. If an old JSON writer reappears after activation, preserve both datasets and stop that writer before reconciling records. Never overwrite the SQL database with an old copy or delete the manifest to force a fresh installation.

An interrupted target switch retains `data/storage/switch.json` and its checksummed transfer archive. Normal startup is blocked until `resume` verifies the target and completes activation. Restore missing connection credentials through the named environment variable; do not put credentials into a shared diagnostic report.

## Downgrade

There is no SQL-to-legacy live writer. Restore the pre-upgrade snapshot into a separate empty Home and use an appropriate old release there. Reconstruct `data/` from the backup, restore `@home/config/` to the Home's `config/`, and restore `@home/plugin.lock` to the Home root. Check inventory hashes before opening the old version. Keep the upgraded Home intact: post-upgrade changes are not part of the historical snapshot.

## Transfer

Use `data pack` for a portable logical backup, and `data merge` or `data move` to restore or combine data. Agent records, revisions and operation receipts move independently of the engine; Git objects and artifacts move with their references. A target Session ID wins as a whole aggregate. The retained source snapshot and transfer report let an operator recover skipped content even after `move --remove-original`.
