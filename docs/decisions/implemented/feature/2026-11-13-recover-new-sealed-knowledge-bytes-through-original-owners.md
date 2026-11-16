# Decision Record: Recover new sealed knowledge bytes through original owners

Status: implemented

## Problem

An H1 knowledge release can contain a new sealed upload whose metadata and physical chunks are absent from an original H0 recovery-held Target. Exact old-byte reconciliation and validated metadata appends cannot reconstruct that content. Native binary preparation also cannot reenter an already held artifact checkpoint or run inside a SQL transaction.

## Decision

The original Publication historical decoder marks only complete validated create receipts, sealed uploads, files, canonical paths, parent directories and chunk metadata. Knowledge retains its immutable release, receipt and index marks. Only artifacts reached by that complete published closure can become native preparation candidates. Existing canonical metadata and bytes remain exact; unknown or unsealed uploads, Selection changes and new Artifact-version metadata remain unavailable.

Writers first validates canonical records without granting physical artifact authority. Its private disk inventory compares actual present and missing references against complete authenticated H1 history. Missing eligible keys pass through RuntimeMaintenance.withRestorationArtifacts with the actual Native.Installed H0 source manifest. Preparation settles outside SQL and checkpoint gates. The subsequent original Target checkpoint verifies complete actual streams and exact opaque native-location witnesses before irreversible Source retirement.

The original restoration transaction publishes native aliases and then only validated missing metadata. Its final strict inventory checks actual canonical keys, locations, metadata and counts; original checkpoint pins remain retained through the actual COMMIT decision and unknown outcomes. Skipped publication, caught errors and late mutations cannot be certified by a callback's successful return.

Physical service namespace labels use ServiceNative's one canonical calculation over kind, organization and deployment identity. Cohort H0 keeps its existing label. Current H1 obtains and verifies the actual NativeNamespaceIdentity and uses that same label. AuthorityJournal's logical organization identity remains distinct and independently checked. Kernel namespace guards remain unchanged. See the [namespace postmortem](../../../postmortem/0176-current-archive-used-a-logical-namespace-as-physical-identity.md).

## Alternatives considered

**Whitelist an entire artifact or publication root.** Rejected because unrelated and incomplete content could enter recovery without its original historical owner.

**Prepare while holding the final SQL writer or checkpoint.** Rejected because native preparation owns independent physical gates and can perform I/O.

**Permit different checkpoint namespaces through a new compatibility capability.** Rejected because the actual defect was inconsistent labels for the same original service. One canonical calculation fixes that defect without weakening the existing guard.

## Consequences

Validated new immutable Knowledge content can recover through its original Home, native staging, Publication, Knowledge and transaction owners. No second phase ledger, materializer, root exemption or execution authority is introduced. Unsupported content domains remain explicit blockers; this does not grant Main continuation or general recovery readiness to other owners.

## Verification

The complete knowledge recovery file passes eight cases and 336 assertions. A public two-chunk upload, seal and release survives recovery, Source format-four retirement, ready publication and two cold ordinary Target reads with the original key, exact receipt, full bytes and unchanged nonempty selection. The existing finalization fault case now uses fresh physical bytes to verify native-alias and metadata rollback for skipped or caught publication, plus exact cold reconciliation after a genuinely committed transaction loses its acknowledgement. The old-byte metadata positive and strict missing/corrupt/unknown negatives remain.

Earlier individual cases overlap this final denominator and are not added to it. Organization typecheck, owning format and lint pass. The underlying native staging primitive has its [separate verification](2026-11-13-stage-artifacts-through-original-restoration-ownership.md). Library, Member and external-owner recovery and new Artifact-version metadata require their own implementation and acceptance.
