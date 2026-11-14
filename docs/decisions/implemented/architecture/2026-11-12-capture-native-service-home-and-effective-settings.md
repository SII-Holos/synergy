# Decision Record: Capture native service Home and effective settings

Status: implemented

## Problem

The canonical service namespace contains signing credentials and resource secrets, but its Home reader marker and organization configuration live outside SQL. The configuration file also does not describe API or CLI startup overrides. A namespace-only checkpoint cannot reconstruct those inputs, and a caller-supplied archive descriptor cannot prove that native material belongs to the current captured namespace.

## Decision

The existing Snapshot checkpoint owner issues opaque archive evidence only for an archive exported by that exact active capture. Issuance freshly consumes the canonical checkpoint verification walk against the actual exporter's fixed manifest and original key provider. Inspection requires its original Runtime, Store, concrete artifact configuration, native Snapshot lease and callback lifetime. A copied token, another capture's valid archive or an expired callback supplies no evidence. Native facets consume this owner-issued evidence; they do not copy the portable parser or introduce another namespace exporter or maintenance operation.

Organization service composition records the effective authentication, registered-client, registration and connection settings, fixed public origin and Web-package requirement before serving. File settings remain independent from that immutable startup snapshot. The configuration owner reads and parses one bounded descriptor, retaining exact JSONC bytes and normalized settings together. It detects pathname and parent-directory replacement, rejects symlinks and preserves cancellation through descriptor cleanup. The ordinary configuration reader delegates to this same parser and snapshot owner.

The internal service-native facet requires current frozen native maintenance, actual service namespace evidence and its owning version-two Home reader. It exports the Home owner, explicit configuration presence, validated raw configuration bytes and effective startup snapshot as a typed canonical Storage checkpoint. The segment is bound to the exact source namespace manifest. It contains no second copy of SQL signing keys or resource credentials. Database target credentials and cloud provider composition require their own reconstruction owners; capture refuses to certify them from arbitrary serialized options or closures.

The cohort invokes the facet inside its existing frozen capture callback and includes its manifest in version-two namespace inventory. The encrypted outer recovery archive remains the sole container format. Verification completes the canonical footer and byte checks, validates raw configuration with the owning parser and compares the source namespace identity before returning native material. No segment API installs an active database endpoint, starts a listener or grants execution.

## Alternatives considered

**Use only the organization configuration file.** A service can use API overrides and an independent public origin. The raw file and effective settings must both survive without pretending they are equal.

**Pass a structural manifest or a reader callback.** Another legitimate archive can have valid bytes while belonging to another capture or namespace. The existing checkpoint owner already holds the required physical lease and archive identity.

**Add a second backup coordinator or portable format.** This would duplicate native drainage, encryption, reference verification and cancellation. The facet joins the existing cohort and canonical checkpoint representation.

## Consequences

Service native material is verified alongside its namespace checkpoint, while the report remains namespace checkpoint completeness. Hosted credentials and knowledge caches, external resource segments, new deployment incarnation, revoked credentials, ACL changes and unique old-writer reconciliation remain separate required recovery owners. Cold reader tests do not replace those execution-safety requirements.

## Verification

Harness `test/snapshot/archive-evidence.test.ts` rejects foreign Stores, copied evidence, closed callbacks, another capture's legitimate archive and a valid replacement namespace. The existing Snapshot checkpoint suite preserves physical capture and shutdown behavior. Organization `test/configuration.test.ts` covers exact JSONC, absence, original cancellation, valid pathname replacement and a parent symlink reaching the same original inode. `test/backup/service-native.test.ts` exercises effective overrides independently from disk settings, encrypted outer-container roundtrip, deletion of original capture files, independently restored Home/config/SQL/signing readers, frozen restored admission, missing markers, unsupported external composition and cancelled descriptor cleanup. Its ordinary-service cohort case first reproduced a missing native segment and then verified actual immutable startup overrides. Cohort and service suites cover integrated namespace capture.
