# Decision Record: Inject encrypted secret persistence

Status: implemented

## Problem

A Host-local Secret Vault makes historical secret references depend on the original Host. Copying plaintext values into database records or operation receipts would enlarge their exposure, while silently replacing an unreadable remote vault would lose references and policy history.

## Decision

Runtime composition may register `SecretVault.Persistence`. The existing local vault remains the default. `encryptedSecretVault` implements database-backed storage with per-entry AES-256-GCM envelopes. Associated data binds the stable authority, secret identifier and external key version. Key providers supply current and historical keys outside database transactions; keys are never persisted alongside ciphertext.

Mutations serialize within the Runtime, decrypt and encrypt outside retryable SQL callbacks, then commit with an expected revision and an operation receipt. The transaction returns no secret-bearing result. Missing keys, invalid envelopes and failed authentication propagate as errors without creating an empty replacement. A mutation re-encrypts all entries with the current version atomically, preserving policy and history.

## Alternatives considered

**Store plaintext in PostgreSQL.** This exposes values through backups, debugging and portable records.

**Keep an encryption key only on the original Host.** This prevents recovery after that Host is lost.

**Fall back to a local empty vault after a remote failure.** This converts an availability failure into data loss and inconsistent identities.

## Consequences

The embedding application owns tenant/profile authority identifiers, key distribution and retention of old key versions. Its maintenance flow must re-encrypt historical rows before retiring a key. The [encrypted store tests](../../../../packages/harness/test/secrets/encrypted-store.test.ts) cover Host replacement, key failure, scope binding, concurrent policy enforcement, key rotation and plaintext exclusion from receipts; the same contracts are registered for PostgreSQL. This does not implement transparent key-service recovery or move local vault files automatically.
