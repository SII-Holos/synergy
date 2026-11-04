# Decision Record: Publish MCP credentials atomically

Status: implemented

## Problem

OAuth cleanup updates the credential document while readers continue checking the completed login. Serializing mutations prevents overlapping writers but an in-place file replacement exposes an empty or partial document to independent readers. A valid stored login can consequently appear absent during PKCE cleanup.

## Decision

The MCP credential writer uses the shared atomic-file utility with private and durable writes. It stages a complete document with private permissions, flushes it, renames it over the committed file, and syncs the directory where supported. Readers retain the previous complete document until publication and read the replacement afterward. The existing authorization ownership, snapshot comparisons and mutation queue remain in force; the persisted format and public API are unchanged.

## Alternatives considered

**Wait or retry in the lifecycle test.** That would conceal an observable credential-read failure while cleanup is running.

**Serialize only in-process readers with mutations.** This would not protect another process reading the file and would unnecessarily delay reads that can use the complete committed document.

## Consequences

Credential writes incur the existing durable atomic-file publication cost and retain its bounded Windows sharing-violation retries. The regression observes real credential reads at the filesystem publication boundary, rejects in-place truncation, checks the final cleanup result and retains private permissions. Existing OAuth lifecycle tests continue asserting that late refresh outcomes cannot overwrite a completed login. No migration is required.
