# Decision Record: Retire centralized identity and channel credentials

Status: implemented

## Problem

Personal work does not require a centralized identity. Retiring the identity integration must preserve readable history and unrelated provider credentials, including upgrades from older credential formats and configuration imports.

## Decision

Harness registers separate startup migrations for retired identity credentials and file configuration. Credential cleanup precedes the legacy provider-store conversion, operates on raw records under the provider-store lock, and preserves unrelated fields and pool entries. Changed secret files are atomically published with private permissions. Invalid credential stores fail the migration without being replaced with an empty store.

Configuration retirement removes the former identity domain, its legacy fields and the dependent channel accounts. The central import transform also handles configuration discovered after startup. Saved feature choices are retired explicitly while unknown and unrelated choices remain intact. Exclusive configuration hosts still migrate credentials and leave file configuration pending.

Historical migration receipts and Session records remain intact. Contact and mailbox records stay stored without active readers. Repository identities, product domains and Desktop application identifiers retain their existing values.

## Alternatives considered

**Rely on schema parsing to drop unsupported credentials.** This can discard a mixed credential pool and leaves retired secrets on disk. A versioned raw-data migration makes the deletion precise and repeatable.

**Delete all identity-related data.** Contact, mailbox and Session history have independent archival value. Only retired authentication material and configuration are removed.

**Combine credentials with file configuration.** An exclusive configuration source replaces configuration files but still uses the local credential store. Separate migrations preserve that distinction.

## Consequences

Fresh installations and upgraded Homes use the same current path. The retirement retains a small historical transform and migration receipts, but does not require a live identity component. Invalid secret files require recovery rather than silently losing unrelated credentials.
