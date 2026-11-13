# Decision Record: Resume backup preparation through original native witnesses

Status: implemented

## Problem

An organization recovery can stop after its actual Source has drained and frozen but before its immutable Reference has been saved. A new Runtime cannot borrow the old process's lease, and the Reference cannot supply authority before it exists. Treating a work directory or a matching request label as authority would permit a different native Source or Target to replace the original operation.

## Decision

`RuntimeMaintenance.beginSourcePreparation()` persists a version-three native operation in the existing maintenance journal. Its registered owner captures the original format-two Home, native namespace, signing identity and Target selection. The kernel binds that selection to the actual writable primary SQLite Store, local artifact configuration, physical Home and server writer. The original request receipt and writer cohort remain authoritative.

`withSourcePreparationRecovery()` reopens only that original draining or frozen operation. It verifies the native selection outside SQL, carries synchronous native ownership into commit guards, reconciles frozen owners and expires the recovered lease when the callback ends. The same capability can drain and capture; it cannot reserve retirement or release the cold Source hold. A durable complete Reference and the existing pending-retirement owner must authorize the later retirement.

The Service consumes the actual recovery Target callback and an opened private work-directory descriptor. Its restricted Source opener attaches the original signer and authority history without migrations, authentication, transports or execution. Same-request retry captures under the native witness, durably saves the complete Reference, closes the preparation owner and proceeds through the existing pending-retirement entry. Changed physical work, Target or configuration remains blocked.

Completed records and native facets are reopened through their original owners without replacement. Snapshot capture requires the private Source preparation lease inside its exact open frozen frame, verifies the original directory descriptor and complete archive, and compares every entry against the actual current namespace before and after rebuilding its own index. Only its own map can supply Archive evidence. The resulting readers and evidence also expire when that frozen frame ends, even while the surrounding Snapshot capture remains open.

The same namespace comparison serves pending retirement and returns no authority. A dedicated mismatch error lets that caller preserve its original public error semantics while I/O, cryptographic and cancellation failures propagate unchanged. Native facet reuse additionally verifies actual Home, namespace, signing, startup settings and configuration, preserves the original archive identity and clears temporary configuration bytes. A missing facet still uses its original producer.

Home upgrades and Source preparation share private physical-owner and native-transition helpers. Their versioned purposes, selections and public recovery entries remain distinct. Legacy maintenance records and version-two Home upgrade serialization retain their existing readers.

## Alternatives considered

**Authorize from an existing work directory or request ID.** Neither proves the original physical primary, selected Target or native drainage. The original native witness is required before capture can resume.

**Recreate maintenance under the new Runtime.** This loses the original operation and writer receipts, and could release a Source whose original effects remain held.

**Give preparation the full retirement capability.** A frozen Source alone does not prove that its complete Reference was durably selected. The existing Reference owner retains that separate responsibility.

**Export again over a completed facet.** Replacing the directory would discard the original captured identity and material. Read-only reopening requires complete original ownership and current-fact comparison instead.

## Consequences

The kernel supports ordinary format-two SQLite Homes with local artifacts and a registered native selection owner. It does not infer support for restored Homes, external primary backends or unfinished facet streams. The owning tests preserve original identities across a real cold reopen, reject legacy holds, rebound canonical actors and changed current contents, and verify callback expiry and denied retirement/release. Real CLI children are killed before capture, after records complete, after both facets complete and after the Reference is durably written without an acknowledgement. Retries preserve original operations, archive identities and complete facet files. The lost-acknowledgement case exercises the existing durable Reference owner. See [original Home upgrade ownership](2026-11-13-resume-home-upgrades-through-original-maintenance-owners.md).
