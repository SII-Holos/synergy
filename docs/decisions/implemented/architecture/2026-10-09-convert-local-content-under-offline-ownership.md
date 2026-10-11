# Decision Record: Convert local content under offline ownership

Status: implemented

## Problem

Selecting object-backed content for a populated SQL namespace leaves historical artifact locators, asset URLs, full output paths, local Git trees and Secret Vault entries dependent on the previous Runtime's directory. Copying SQL records alone cannot make that history recoverable.

## Decision

Expose `storage/local-content` as an explicit maintenance operation. It reads an independent, immutable local backup and writes through the same durable readers and writers used by Runtime composition. The caller owns writer fencing, backup verification, capacity limits and final activation. The conversion preserves asset identities, exact historical output aliases, snapshot Git OIDs and secret policy/audit metadata. Secrets use the target's authority-bound encryption keys. Each write is read back; snapshot verification restores a new cache and runs Git integrity checks.

Missing content, malformed secrets, external Git dependencies, links and exceeded limits fail before the caller may activate its target. A partial conversion can be repeated from the unchanged backup; it neither deletes the original nor acknowledges an incomplete target as ready. No online fallback to the old directory is introduced.

## Alternatives considered

Keeping the old Host as a fallback preserves deployment affinity and hides missing object data. Reassigning content identifiers breaks historical messages. Combining product-specific admission and backup policy with the generic converter would give the harness ownership of deployment concerns.

## Consequences

Hosts must provide an independent source Handle and retain the backup until their own activation and restore checks pass. Tests remove all original content and target caches before reading through durable APIs, inject upload failures and verify repeatable conversion, damaged-content rejection, and legacy/shared snapshot recovery. PostgreSQL behavior still requires the real backend matrix; in-memory object tests are not a deployment acceptance result.
