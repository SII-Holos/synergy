# Decision Record: Persistent volume directory identity

Status: implemented

## Problem

A filesystem device number identifies a current mount, not a durable volume. Persisting it as directory identity can reject an unchanged directory when the operating system assigns a different device number. Ignoring that mismatch would also accept unrelated directories with coincidentally equal inode numbers.

## Decision

Local Runtime qualifies macOS durable directory identity with the native volume UUID, inode and birth time. Inspection checks the object again after reading its volume identity. Other platforms and volumes without a UUID retain strict device-qualified identity. A stored volume-qualified identity cannot silently downgrade when volume inspection fails.

The Workspace startup migration upgrades only local active bindings whose complete legacy identity still matches. It preserves Workspace IDs and binding generations, advances the catalog revision and replaces location indexes transactionally. The dependent Local Runtime migration upgrades verified native mount receipts before admission. Missing, replaced, foreign and already mismatched legacy directories require explicit rebinding. Unknown owner data survives both upgrades. This refines the durable identity in [Workspace bindings](../architecture/2026-09-23-workspace-identity-and-local-bindings.md).

Live native exclusion claims retain current-mount identity and canonical path overlap. They coordinate concurrently running processes, including older runtimes, and are not converted into a second durable catalog.

## Alternatives considered

**Ignore device numbers on mismatch.** Inode and birth time alone do not establish which volume owns a directory. Automatic adoption would weaken replacement detection.

**Rebind every directory during startup.** Rebinding grants access to the directory found at a pathname and invalidates previous generations. Startup cannot make that user decision.

**Upgrade only the catalog.** Native mount receipts independently validate the directory. Both durable owners must migrate before execution resumes.

## Consequences

Normal macOS mount-number changes no longer invalidate newly verified durable bindings. Legacy records with insufficient evidence still require one explicit recovery action. Native tests cover replacement, missing and foreign directories, index consistency, repeated upgrades, receipt restoration and JIT-disabled execution; pure identity tests cover device-number changes and distinct volumes.
