# Decision Record: Own cloud catalogs in organization storage

Status: implemented

## Problem

Shared cloud files and compute need current organization authorization and one canonical resource lifecycle. Copying a writable file head into each executor's local catalog would permit independent commits and lose conflict checks.

## Decision

Keep organization cloud locators and idempotency receipts in the organization's isolated storage namespace. Locators contain ownership and naming only. Workspace content, revisions, binding generations and mount state remain exclusively in Harness `WorkspaceCatalog`; Environment allocation, generations and uses remain exclusively in Harness `Environment`.

Extend the existing resource configuration and account/project grant matrix with Workspace storage and Environment profiles. Public execution descriptors contain only the protocol; infrastructure profiles and credentials stay with the trusted composing owner. Cloud composition registers explicit blob stores and Environment providers before sealing, without reading personal configuration.

Creation binds logical resources without allocating compute. Bounded file reads use current resource grants. File writes prepare immutable objects outside retryable transactions, then recheck current authorization, compare the canonical Workspace revision, and publish its head with the stable operation receipt in one transaction. A repeated operation returns its original receipt after reauthorization. An occupied identity with different input fails. Active mounts retain the existing Workspace owner's exclusion and cannot be overwritten through dormant file APIs.

## Alternatives considered

**Build a separate cloud filesystem.** This would duplicate path, content and lifecycle rules.

**Replicate mutable Workspace heads in Runtime Homes.** This would create multiple writers.

**Carry infrastructure credentials in execution descriptors.** This would widen the trusted boundary to Agent workers.

## Consequences

Cloud catalog and file APIs reuse canonical owners and the existing grant matrix. Current authorization gates receipt reads as well as file access. Uploaded immutable objects can remain unreferenced after a failed CAS; they do not publish a file change. Remote execution and Session handoff are separate protocols and do not become authorized by creating a cloud locator.
