# Decision Record: Fence recovery Homes before installing native files

Status: implemented

## Problem

A recovered namespace must not publish its archived Home ownership marker as live target ownership. Released format-one and format-two readers do not know the new installation intent and could read source credentials or open SQL before the current recovery policy runs. A partially installed target also needs a cold restricted reader without weakening ordinary startup or creating a second phase ledger.

## Decision

The canonical `HomeOwnershipFile` owner adds strict format three. It retains the domain owner, identity and reader contract, plus references to the existing `HomeRestoration` installation ID and fresh incarnation. It carries no independent installation phase. Formats one and two remain supported inputs for their existing owners; they are never installed over a recovery target's format-three fence.

`HomeRestoration.installOwner` publishes this marker only from its actual open native installation permit. The owning domain supplies its identity/reader definition; owner, installation ID and incarnation come from the original durable intent, not a DTO. The same native Home-owner file lock and durable atomic writer own publication. Retrying exact format three is idempotent; replacing another owner or changing its references fails. The fence is permanent: a later recovery policy must use the same intent's actual final receipt rather than rewriting the marker to an older format.

For a cold restricted boot, `assertPendingOwner` reads the same intent and verifies native Home/root identity and exact owner/reference fields before SQL opens. It does not inspect a Store, authorize installation or grant normal reads. After Store attachment, `begin` and the installation permit still rebind the complete actual database/artifact target. Only the explicit service recovery entry selects this pending owner; ordinary startup remains closed.

The service-native owner verifies the original fixed checkpoint and native segment through the canonical archive reader before any file effect. The intent binds the complete canonical namespace manifest hash. Its strict domain request also binds the exact native-facet manifest hash and the outer archive/cohort participant mapping. The validated request is privately snapshotted before the first await; the generic permit owner's hash comparison detects drift without granting authority. Two valid native segments for the same SQL checkpoint cannot substitute for one another. The service owner validates archived ownership through its own definition, publishes format three, and then installs only its exact optional organization configuration bytes. The existing configuration parser and descriptor reader verify those bytes, normalized settings and explicit absence. Existing conflicting target files are preserved and rejected. Archived startup endpoints and credentials do not become active application authority.

The prepared result and native installation evidence belong to the original callback, Runtime, primary Store and native permit. Pure owner assertions can join a later SQL commit guard; asynchronous verification rechecks the actual marker and configuration. Copies and closed evidence cannot establish installation. This unit does not update the intent's `staging` phase or expose a ready/Continue operation.

## Alternatives considered

**Copy the archived ownership marker.** An older reader could treat the restored Home as an ordinary existing deployment and initialize or use source authority before recovery reconciliation.

**Downgrade the marker after installation.** That would reopen the same legacy-reader path precisely when imported credentials and SQL become present.

**Give recovery a second native ownership ledger or a boolean reader bypass.** The existing intent already owns phase, target identity and retry. A separate label or caller flag would not prove its actual publication state.

## Consequences

Current recovery can durably install service-native material and cold-reopen its original pending target while older strict readers remain fenced. Hosted binding/credential installation, canonical Snapshot adoption, maintenance-history adoption, fresh authority, current ACL reconciliation and old-writer retirement remain separate required owner units. External reconstruction requirements remain blocking. No normal login, model call, tool submission or historical input replay is introduced here.

## Verification

Harness installation tests exercise actual intent-derived references, idempotency, rejected DTO overrides and expired callbacks. A standalone fixture preserves the literal ownership schemas from revision `68fba4592`, without importing the current parser. Positive controls perform a real Node credential-file read and a Bun SQL write; format three rejects both before those operations and leaves no target row.

`packages/organization/test/backup/service-native-install.test.ts` uses an actual service, native maintenance, fixed protected checkpoints and the encrypted cohort. It removes the source Home and container, installs verified configuration only after observing format three, and reopens an independent cold restricted target. It verifies exact bytes, retained incarnation, zero initialized SQL records, original evidence, closed/copy rejection, another namespace and another native domain before file publication. Another canonically authenticated configuration facet for the same SQL checkpoint first reproduced incorrect acceptance; the original domain request now rejects it before publishing a fence. Existing service-native and restricted-startup tests retain their original coverage.
