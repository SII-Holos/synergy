# Transactional Agent Storage Upgrade

## Upgrade

Stop the instance through its normal user-facing shutdown flow before running offline maintenance. The next Runtime startup, or `synergy data storage resume`, acquires exclusive Home ownership, backs up original data and configuration, imports legacy records, runs the installed domain migrations and activates SQL authority. Never run an old binary against an activated Home.

The immutable backup is `data/storage/backups/<backup-id>/`. Version 2 uses bounded `chunks/` and `groups/` files plus a sealed `manifest.json`. Each group stores a compressed path/hash inventory and independently raw/gzip encoded original file bytes; files larger than 2 MiB receive a streamed raw chunk. Group descriptors publish only after chunk durability, and the manifest seals their checksum, counts and source identity. Configuration and plugin installation metadata use `@home/` paths inside the inventory. Workspace symbolic links are preserved as links and never traversed. Authoritative record links are rejected.

An interrupted version 1 import keeps its version 1 importer and backup: `inventory.ndjson` plus original files under `data/`. After that import, the registered `20260916-packed-artifacts-v2` migration packs loose Rollout binary evidence using a separate artifact-only backup. New imports prepare SQL records and binary locators together with bounded batch checkpoints. The backup remains independently readable without the SQL database.

Before copying, bootstrap budgets the uncompressed backup plus path metadata and group allocation, SQL records and locators, journal growth, domain migrations and a recovery reserve. SQL overhead allowances are conservative planning estimates, not measured ceilings; retained originals receive no early-deletion credit. Capacity is checked again before backup chunks and import batches. Raw backup chunks shared with canonical artifacts count once on the same filesystem; cross-filesystem copies need their own space. Corrupt global Scope or migration-ledger records block activation even on repeated resume.

Repeated `resume` uses recorded checkpoints and the same sealed backup. It rejects changed source files, missing backup bytes and identity mismatches. A record with invalid historical JSON is preserved in the backup and assigned a persistent recovery issue. Affected Sessions cannot execute until their evidence is repaired and their block is resolved. Do not delete a recovery marker merely to bypass a failed upgrade.

Activation retires originals only after re-checking every byte count and complete content digest against the sealed inventory. Backup verification is also complete; a mismatch fails activation and leaves the affected original in place. Resumed retirement tolerates originals already removed after successful verification.

## Verify and troubleshoot

`data storage status` reports the active backend, namespace, database/artifact identity, recovery records and outstanding notifications. `data storage verify` reads database integrity, record relationships and all referenced artifact bytes without modifying authority and returns a failing exit code for reported issues. Storage I/O, authorization, ownership and malformed engine/configuration errors remain fatal rather than becoming empty data.

If an upgrade is interrupted, preserve the entire Home, correct the reported cause and run `resume`. If an old JSON writer reappears after activation, preserve both datasets and stop that writer before reconciling records. Never overwrite the SQL database with an old copy or delete the manifest to force a fresh installation.

An interrupted target switch retains `data/storage/switch.json` and its checksummed transfer archive. Normal startup is blocked until `resume` verifies the target and completes activation. Restore missing connection credentials through the named environment variable; do not put credentials into a shared diagnostic report.

## Downgrade

There is no SQL-to-legacy live writer. For a sealed version 2 Home backup, run `synergy data storage restore-backup <backup> <new-home-directory>`. Restoration validates every chunk and the final inventory in a staging directory before publication; the destination must not exist. It recreates data, configuration and plugin metadata without opening SQL. Use an appropriate old release only against this separate Home. Post-upgrade changes are not part of the historical backup.

For version 1, reconstruct `data/` from the backup, restore `data/@home/config/` to the Home's `config/`, and restore `data/@home/plugin.lock` to the Home root. Validate all inventory hashes before starting the old release. The version 2 restore command deliberately rejects version 1 and artifact-only backups.

## Deferred session import

New manifests automatically select staged import when every non-separable registered migration is already recorded complete in the historical domain ledgers. Missing or unknown ledger evidence selects the complete startup path. `SYNERGY_STORAGE_COMPAT_DEFER=0` forces the complete path; `=1` opts into segmented import but does not bypass shared migration barriers. Existing manifests retain their original protocol.

Version 3 atomically relocates the Session tree into `data/storage/legacy/<backup-id>/sessions/` and durably records its identity and complete owner inventory in `backups/<backup-id>/segmented.json`. The `global/` segment seals non-Session bytes and configuration before activation. Each `sessions/<scope>/<session>/` segment uses the independently verified packed format and must seal before that owner imports. Until every segment seals, the frozen source is part of the recovery set, not an independent backup. Preserve both trees when copying an unfinished upgrade.

The central runner declares global, Scope, Session and derived work. Scope-wide and unclassified work stages the unresolved cohort before proceeding. Explicit Session callbacks participate in the same registered graph and persist per-owner receipts; domain completion stays pending until the cohort converges. Idle Sessions can remain deferred while new work starts. Owners with active recovery flags import first, and each touched owner completes migration and Rollout recovery before admission. Recovery cannot declare a missing historical cohort empty.

Touch and endpoint delivery import before business transactions; an in-transaction attempt fails without retiring source files. SQL batches are bounded by rows and bytes. Backup artifact blocks are reused where possible. Every recognized original digest and target artifact is verified before atomic owner publication. Segmented imports then enqueue durable source cleanup; interrupted older retirement retains its original recovery protocol. Unknown auxiliary files remain preserved. Malformed data is quarantined; I/O failures retain retryable state. Listings read the SQL catalog without repeatedly parsing the source tree.

The Runtime continuously schedules bounded batches, preferring recent historical activity, with retry backoff and pauses between batches. Use the status bar or `data storage history pause` to pause background work at resumable boundaries. Requested Sessions take priority and may finish while background work is paused. Shutdown stops and drains it. The Web status bar and `GET /global/storage/upgrade` expose convergence counts; `/global/storage/upgrade/sessions` pages unresolved owners. HTTP readiness admits new work, not a claim that history is fully migrated.

`data storage restore-backup <backup> <new-home-directory>` also restores versions 3 and 4. Sealed segments restore without the original tree or SQL. Unsealed segments require the matching frozen source, which is sealed before restoration; missing or replaced source is an error. Restoration publishes only after all segments validate. Pre-upgrade backups never include subsequent SQL writes. Pending and quarantined owners continue to block pack, merge, move and backend transfer.

Format 4 is selected for eligible new upgrades. It keeps legacy Git snapshot paths intact under a durable mutation guard and backs them up per Scope after readiness. Preserve both the frozen Session tree and the original `data/snapshot/` tree until status reports independent backup completion. A copied, fully sealed format 4 backup restores without either original; absolute Git alternates inside the backed-up snapshot roots are rewritten to relative paths in the new Home. An external dependency blocks sealing and requires operator repair.

`ready`, `historyReady`, and `backup.complete` describe separate milestones. An old Session opens through an asynchronous preparation page with progress, return and retry controls. HTTP clients use `GET /global/storage/upgrade/sessions/<id>`, `POST .../<id>/prepare`, or `POST .../<id>/retry`; background pause/resume uses `POST /global/storage/upgrade/control`. A long ordinary Session request may return `SessionPreparingError` with HTTP 409 and `Retry-After`; poll preparation before retrying. A retry never clears quarantine or overwrites a sealed backup.

A full SQLite `VACUUM` conversion is optional and is not required for new work. Stop the Runtime normally, retain the recovery set, ensure free space for the database rewrite and run `synergy migration run storage --maintenance`. Necessary schema/index work and physical verification use a finite size-based engine budget; repeated Desktop progress records do not extend that same operation indefinitely.

## Transfer

Use `data pack` for a portable logical backup, and `data merge` or `data move` to restore or combine data. Agent records, revisions and operation receipts move independently of the engine; Git objects and artifacts move with their references. Grants, consent and trust records (plugin approvals, permissions, registry) are refused from another home's archive during `data merge` and only travel with `data move`. A target Session ID wins as a whole aggregate. The retained source snapshot and transfer report let an operator recover skipped content even after `move --remove-original`.
