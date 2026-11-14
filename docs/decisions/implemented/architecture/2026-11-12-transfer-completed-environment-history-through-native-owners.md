# Decision Record: Transfer completed Environment history through native owners

Status: implemented

## Problem

Descriptor-only Environment portability blocks Sessions that retain completed native operations. Dropping these records loses original execution identity, output and owner extensions. Recreating allocations or reusing the live execution writer would instead change historical facts or grant current native resource authority to source receipts.

## Decision

The `session-environments` contribution publishes reader 2 and retains reader-one descriptor packages. New source seals include an exact operation count. Stored descriptor and receipt schemas explicitly distinguish versions; the Environment central migration validates retained versions in bounded pages. The portable owner version rejects an older receiver before body installation. The execution storage envelope remains its existing strict version 2, including unknown canonical owner fields.

Only Session-attributed completed records with matching terminal receipts, drained native trees/streams and complete output cursors are admitted. Source reads the existing canonical origin index and actual stored record; no second execution inventory or occupancy authority is introduced. Every native output key must belong to that original operation and complete its cursor range. Output bytes use the existing bounded JSON frame and binary storage format without decoding/re-encoding their payload.

The canonical Session origin validator and staged Core verifier share a pure tuple check. Native indexing and receiver validation share the exact latest/tied-input selector. The receiver streams wanted invocation identities into a private temporary SQLite index, scans Core tools once, then reads original root, assistant, Run and selected tool records by owning keys. Ambiguous or missing evidence rejects even when a source supplies a plausible tool locator. Temporary rows are verification data and are removed after the callback.

Target preparation verifies all output frames before the activation transaction and binds a fingerprint of canonical records and immutable artifact metadata to the original Context, Runtime, Store, configuration and signal. Publication rechecks metadata and current mapping, installs only completed records through the owning import path, rebuilds canonical origin indexes and links the verified binary references. It does not call the live execution writer, update historical timestamps or recreate active Uses, providers, allocations or mounts. Environment binding, operation facts, output references, receipt and paused Core metadata commit or roll back together.

An imported record retains its original target and historical Workspace references. Its output can be read without that source allocation on the target. Current execution still uses the target catalog and original operation-input checks; an old operation ID cannot become a new command against another Environment. Member and hosted Runtime composition registers the reader. This does not enable the complete machine handoff control surface.

## Alternatives considered

**Export descriptors and omit completed records.** This silently loses retained facts and prevents exact recovery or output access.

**Map historical targets to the new allocation.** That rewrites original physical evidence and can confuse old operation IDs with fresh execution permission.

**Trust the sender's tool locator.** It cannot prove the canonical latest/tie decision against all staged tool records. The target repeats the same selector with one bounded scan.

**Read every output body while publishing.** This holds the native SQL writer during potentially large I/O. Preparation verifies complete immutable frames, and publication checks their fingerprint and links exact references.

## Consequences

Completed supported history remains readable on another Home without source provider state, while interrupted, active, incomplete and unattributed operations remain blocked or retained by their existing owners. This unit does not implement active Task interruption/drain ordering, logical cloud Environment mapping consent, WorkspaceMove authorization or Main enablement.

Verification uses Local Runtime `test/session-transfer-environment-history.test.ts` for actual execution, multiple output frames, atomic rollback, original unknown fields and complete rehashed package failures. Harness `test/session/transfer-environment-origin.test.ts` compares real native latest/equal-input/ambiguous/missing/root cases and original cancellation; `test/environment/{execution-portable,transfer-records}.test.ts` covers strict storage and reader versions. Organization Runtime `test/runtime.test.ts` verifies actual enrolled canonical registration.
