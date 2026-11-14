# Decision Record: Bind service native and Snapshot installation

Status: implemented

## Problem

The service-native installation request accepted only its native segment and cohort mapping. Snapshot installation required a Snapshot manifest in that same original request. Both owners worked independently, but an actual service checkpoint containing Snapshot history could not install them through one durable intent. Joining their callbacks also needed both native lifetimes at the raw import's final commit decision.

## Decision

The service-native production request requires the full namespace, native and Snapshot checkpoint manifests. It validates their strict schemas, canonical facet archive roles, matching namespace and capture build identity, and the namespace/archive identities derived by the actual cohort producer. The original strict payload retains the native hash and cohort mapping and adds the required Snapshot manifest hash. Cohort version two always captures a Snapshot segment, including an empty segment; absence cannot imply an empty graph.

Native installation rechecks the source/cohort association before any file effect, including requests supplied without the convenience constructor. Each owning installer independently verifies its actual archived material and binds its opaque evidence to the same complete request and Home installation permit. No caller-supplied hash or inventory label establishes native installation. Native-only pending requests cannot acquire a missing Snapshot identity through rewriting their original intent; their existing Home fences remain closed.

The service-native `adoptRestoration` operation requires both actual installed owners and the checkpoint importer's original transaction evidence. It appends both owners' pure checks to that importer's native final commit guard, then delegates to the existing maintenance adoption. The original checkpoint receipt, target installation ID and recovery-held reference remain canonical. No additional receipt family or phase ledger is created.

Cold retry verifies the original native configuration and physical Snapshot closures, reuses the installation identity and retains the recovery hold. Existing recovery signing preparation accepts the same complete request while preserving its archived H0, active source signer and authentication records. This unit does not apply a later journal suffix, establish current private policy or source-writer retirement, publish active fresh authority, or enable ready or Continue.

## Alternatives considered

**Make the Snapshot facet optional.** The actual cohort schema and capture producer always emit it. Optional parsing would hide an incomplete installation request rather than establish an empty Snapshot inventory.

**Create a second Snapshot installation intent.** The namespace, physical files and maintenance hold would acquire different request identities and could not prove one target installation.

**Check only in the convenience constructor or callback body.** A directly supplied strict DTO can bypass constructor association checks, and an actual delayed import can commit after only the Snapshot callback closes. The native file owner revalidates its source and the importer retains both final guards.

**Activate the prepared signer after the files install.** Snapshot closure and an imported namespace establish historical bytes, not the final source suffix, current private authority or unique physical writer.

## Consequences

Service-native and inactive-signing fixtures consume the required Snapshot segment through the existing native owners. Hosted native and knowledge facets remain separately owned; this service request cannot admit them. Recovery still requires the original archives and keys to verify or resume installation.

The joint service test captures a real initialized service and physical Snapshot tree, removes its source Home and encrypted container, and installs from the authenticated plaintext staging directory. It covers exact cold retry, changed Snapshot request replay, a coherent foreign service checkpoint, facet role confusion, direct forged cohort mappings, Snapshot-only callback expiry at actual last-write admission, and cancellation rollback with cold recovery. See [the postmortem](../../../postmortem/0131-service-recovery-request-omitted-its-snapshot-facet.md).
