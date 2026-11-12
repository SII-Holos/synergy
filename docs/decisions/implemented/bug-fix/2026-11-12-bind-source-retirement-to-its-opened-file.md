# Decision Record: Bind source retirement to its opened file

Status: implemented

## Problem

An absolute-path atomic rename can write an irreversible source-retirement marker into a replaced native Home after the original physical check. Refusing the final observation does not remove that foreign effect. See the [incident](../../../postmortem/0144-source-retirement-fenced-a-substituted-directory.md).

## Decision

The retirement path opens the original regular, single-link ownership file without following links, compares descriptor identity and size to its bounded native observation, and checks the selected physical Home again before publication. It retains that descriptor for truncation, complete writes and synchronization. Directory or ownership-file substitution cannot redirect those writes into the replacement inode. Final pathname validation still rejects a detached publication rather than returning retirement evidence for the replacement.

Truncation is synchronized before writing the deterministic format-four marker. Empty or partial writes remain invalid to ordinary startup and literal prior readers. Retirement-only inspection accepts only the exact original owner, the selected completed marker, or a strict byte prefix of that marker. It is a no-effect observation. The owning Domain must match the actual primary Store, process lock, physical Home and committed immutable retirement reference before retrying publication. A malformed file outside that prefix remains blocked; missing files and links cannot be adopted.

The existing frozen operation and immutable reference remain the only retirement intent. The file inspection introduces no additional phase ledger or generic startup repair. This refines the publication mechanism of [source retirement reservation](../architecture/2026-11-12-reserve-source-retirement-before-native-fencing.md).

## Alternatives considered

**Check the physical directory after an atomic pathname rename.** Detection occurs after the wrong directory has received the marker.

**Add another check immediately before rename.** There is still an unbound pathname lookup between that check and the effect.

**Add a platform-specific descriptor-relative rename backend.** The portable owner can retain the existing inode without introducing a second native filesystem implementation. The deliberate tradeoff is an invalid intermediate file rather than all-or-nothing marker replacement.

## Consequences

Power loss can leave an invalid ownership prefix, so ordinary startup remains unavailable until the original reserved retirement completes under restricted native authority. It cannot silently restore the prior executable owner. Exact unknown-result retries synchronize the retained marker again. Tests replace the directory and the file during real writes, interrupt publication, reject unrelated malformed bytes and retain the literal-reader credential/SQL exclusions.
