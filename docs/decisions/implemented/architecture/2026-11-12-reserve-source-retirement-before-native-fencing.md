# Decision Record: Reserve source retirement before native fencing

Status: implemented

## Problem

Recovery cannot treat a revoked connection or an ordinary frozen backup as permanent old-writer retirement. A native fence can also lose its acknowledgement. Releasing the source during that uncertainty could reopen execution, while copying a retirement marker to another Home cannot establish that the original directory was fenced.

## Decision

`RuntimeMaintenance.reserveRetirement` consumes only the original live `withFrozen` callback and opaque source lease. It atomically records one immutable reference hash with the exact frozen source operation. A changed reference rejects; an uncertain committed acknowledgement is inspected and retried through that same operation. The source phase remains frozen and its release owner permanently refuses release after reservation. Missing pointers, mismatched frozen history and dangling reserved facts remain blocking.

The reservation is an intent rather than physical-exit evidence. Its new record family has strict owning import and paged physical migrations. The original maintenance schema is shared as a pure leaf without changing its persisted format or creating another phase ledger. Ordinary admission reads the current operation and possible retirement in one batch.

`HomeOwnershipFile` supports an explicit format-four retired owner retaining its original format-two or format-three identity, maintenance identity, reference hash and physical directory hash. The native publication requires the exact original owner, preserves the first result across lost acknowledgements and rejects another retirement. The physical hash uses canonical directory identity, including normal operating-system path aliases; a copied marker cannot validate another Home.

Format four is required because the literal released format-two reader accepts arbitrary reader-contract strings. Merely changing that string would still allow its credential reads and SQL startup. The new format is a deliberate refusal for those old readers, without fabricating a restoration installation identity. Normal startup does not silently migrate or adopt a retired Home.

## Alternatives considered

**Release the backup hold before native publication confirms.** An unknown file outcome could leave the old source executable.

**Use a new phase or parallel retirement coordinator.** The existing frozen operation plus one immutable reference expresses the irreversible intent; its owner can keep release closed.

**Change only the format-two reader contract.** The retained literal reader does not require a particular contract value and would still open credentials and storage.

**Accept equal marker bytes in any directory.** A copied marker does not prove that its original Home received the fence. Native validation includes the physical directory identity.

## Consequences

The storage and native-file primitives preserve a permanently held source intent and verify a concrete retired marker. Domain composition must still bind that reference to the actual service or Runtime, retain its process lock, drain accepted native publication and reconcile every independent writer before granting target execution. These primitives alone do not complete source-service retirement or deployment recovery.

Harness maintenance tests verify real SQL commit uncertainty, exact retry, rollback at the last reservation write, cold retention and missing-pointer refusal. Record tests reject unknown versions and validate a bad retained row beyond a page without deleting it. Native-file tests run the literal released reader with positive credential/SQL controls, then reject both operations after format-four publication, retain a lost file acknowledgement and refuse another reference or copied directory.
