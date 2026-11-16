# Decision Record: Recover service authority through an explicit administrative CLI

Status: implemented

## Problem

The administrative restore command installs authenticated H0 service bytes and inactive signing material while retaining recovery-held admission. It does not reconstruct final H1 authority, retire the original writer or publish native readiness. A retry after fresh signing publication cannot reopen inactive material as though the Target still held the original source identity. A partially written completion frame also cannot enter through the default strict staging reader.

## Decision

Keep restore held-only and add the explicit recover command. The independent executable exposes synergy-org recover; the shared launcher exposes synergy org recover. The operator selects the existing Target through SYNERGY_HOME, the original encrypted H0 archive and restore UUID, the original Source Home, private recovery keys, an independent private work directory and the recovered HTTPS origin. Source origin is supplied separately when the original effective client settings require it. The command never replays or Continues an Agent task.

Move the original service archive layout/parser and installation-request construction into one callback-bound owner helper consumed by both installation and recovery. Existing-Target recovery requires its actual Home-three owner, original Kernel restoration receipt and exact H0 request. It creates no replacement signing material. The original Native installation and existing Prepared material are reopened only while no guarded publication receipt exists.

Before a permanent source effect, freeze and inspect the original service through its actual installed owners, reject unsupported service-only writers, capture fixed H1 and preflight the real original Target. Durably publish the original Reference in the private work directory through anchored file publication before reserving retirement. The Reference remains a locator, not authority. Existing complete work resumes through Current's private fixed-H1 admission and native cold frozen-source reconciliation; partial or foreign work remains blocked and retained.

Reconstruct and publish through the existing Current, Journal, SourceRetirement, Authority and Publication owners. A committed publication retry first validates that same canonical SQL receipt, durable Reference, original request and complete fixed H1. It verifies the actual cold Source retirement instead of reopening an already activated inactive key. Exact native prefixes are admitted only by the original SQL-backed Publication permit and completion path; default HomeRestoration.begin stays strict.

Await callback results before scoped Runtime disposal and retain actual Source owners through Target native completion and ordinary startup verification. Exit installation callbacks before native completion, complete the original Home intent, release the original adopted hold and verify the fresh deployment through ordinary startup and readiness before printing ready metadata. Errors retain original causes and explain that original Homes/work remain retained; no unknown result starts a different request or key.

## Alternatives considered

**Automatically enabling restore** would change an existing safe held-install operation into permanent source retirement and authority publication.

**A new recovery phase ledger** would duplicate the original maintenance, installation, publication and native intent owners. The work selector stores only their original Reference and origin.

**Reopening inactive material after publication** conflicts with the legitimate fresh identity already committed in the Target. The guarded original receipt owns exact retries.

**Permissive staging reads for damaged completion files** would authorize repair from bytes alone. The original Publication owner must supply its actual SQL-backed permit.

## Consequences

The supported command closes the service-only H0-held-install to current-policy/native-ready path and exact durable-Reference retries. It does not establish full DATA20 recovery, multi-namespace/member/Library/external-resource closure or recovery from a process crash before complete fixed H1 and a usable Reference exist. Unknown owner roots retain their existing guards. The [fixed binary guard](../bug-fix/2026-11-13-verify-fixed-namespace-binaries-before-source-retirement.md) verifies actual native bytes and refuses unsupported H1 artifact changes before permanent retirement.

## Verification

Organization test/cli-recovery.test.ts exercises the real public executable through H0 backup, held restore, H1 password authority, explicit recovery, permanent Source-four, ordinary readiness, actual binary reads and exact retry without changing the original inactive material. test/cli-recovery-retry.test.ts covers durable-Reference pre-reservation failure, a real committed publication whose acknowledgement is lost, an exact native completion prefix, and retained partial work. The clean final combined run is five unique tests and 57 assertions; Organization typecheck and the owned lint/format checks pass. Tests use isolated temporary Homes and never the active application Home.
