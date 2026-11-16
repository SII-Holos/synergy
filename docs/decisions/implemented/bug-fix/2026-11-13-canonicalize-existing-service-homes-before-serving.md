# Decision Record: Canonicalize existing Service Homes before serving

Status: implemented

## Problem

Backup installation and recovery use a canonical physical Home. Ordinary serving retained its caller's lexical path. An ancestor path alias could therefore change the SQLite configuration hash when reopening the same completed installation, even though its original database inode and native intent were unchanged.

## Decision

Ordinary serving resolves an existing ordinary Home to its real path before constructing the Runtime, primary Store or artifact configuration. It captures and validates the original options first. Missing Homes retain the existing initialization path, while a direct Home symlink or non-directory is rejected. An ancestor alias selects the same canonical Home and original native installation.

Restricted upgrade, recovery and retirement openers retain their existing exact configuration semantics. The native installation identity, versioned hash encoding, physical checks and completion verification remain unchanged.

## Alternatives considered

**Use a canonical path only in the test.** Public callers can legitimately supply an ancestor alias. Correcting the fixture would conceal the serving-entry inconsistency.

**Accept either lexical or canonical native hashes.** This weakens the original identity check and changes persisted-state semantics. Normalize serving input before acquiring its native owners instead.

## Consequences

Completed Service installations reopen consistently through ancestor aliases. The regression uses an actual recovered Home and a real symlink ancestor, checking readiness, database identity, unchanged intent bytes and retained prepared material. This does not certify arbitrary legacy maintenance receipts created with different primary configurations. See [the incident](../../../postmortem/0183-service-path-alias-changed-native-recovery-identity.md).
