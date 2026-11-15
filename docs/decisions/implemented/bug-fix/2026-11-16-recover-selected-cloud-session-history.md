# Decision Record: Recover selected cloud Session history

Status: implemented

## Problem

A complete organization backup can contain a Session whose original resource selection refers to a dormant object Workspace and an idle Environment. The resource owner can restore those saved objects, while the historical Session validator rejects every infrastructure selection. A genuine Hosted task also retains a signed pause receipt after selecting the resources; its command-history reader accepts only creation and task-input effects. Both refusals block an otherwise complete recovery before publication.

## Decision

Validate historical infrastructure through the original Cloud resource owner. The canonical locator, organization, project and resource identity must match the Session selection. Reuse the dormant Workspace, saved-head/index and genuinely idle Environment checks. Actual Source and Target resource facets still verify full native objects, target ports, Home installation and final guarded publication; a historical reader supplies no installation capability. See [native resource recovery](../architecture/2026-11-13-restore-service-resource-closures-through-explicit-native-owners.md).

Keep current-policy reconstruction separate from immutable data recovery. A legitimate H1 Session selection can refer to another complete resource pair already present in H0. Original journal adoption installs that H1 contract and revision. A newly added or changed native resource without the original H0 physical closure remains blocked before permanent Source retirement. Resource enablement, current caller authority and execution remain owned by their ordinary gates.

Hosted command history accepts a pause receipt only after its original attempts, request indexes, sequence, identities, binding and Service signature pass. Its permit and effect must both identify pause, and the canonical no-argument pause request digest must equal the signed payload hash. Preserve the original acceptance window without checking historical expiry against the current clock. A real unchanged pause remains valid with `changed=false`; its native paused timestamp need not equal receipt time.

The existing creation and task-input checks remain intact. The pause branch grants no input, root, execution grant or physical completion. Continue, cancel and decision history need their own native evidence and are not admitted by this branch. The completed-grant reader retains its task InputAccepted, root, released generation and provenance checks. Hosted publication still requires actual permanent native writer proof and restores paused work. See [Hosted publication](../architecture/2026-11-13-publish-recovered-hosted-writers-after-original-service-reconciliation.md).

## Alternatives considered

**Reject every infrastructure selection.** This prevents recovery of complete, ordinary selected Sessions even when their original resource facets are verified.

**Accept any control effect.** Continue, cancellation and decisions have additional native effects and evidence. Their type alone cannot certify those facts.

**Force every H1 selection to equal H0.** Session resource policy belongs to the original current-authority journal. Complete backed alternatives can be selected legitimately without changing immutable native data.

**Treat historical validation as fresh authority.** A matching reference or receipt cannot replace target installation, permanent writer evidence, current authorization or a separate explicit Continue.

## Consequences

Readable recovered metadata preserves original Session, driver, epoch, contract revisions and retained objects without starting compute or replaying models. Unknown owners, retained activity, incomplete or changed physical closure and unsupported command effects retain their blockers. No persisted schema, wire version, generated API or new recovery ledger is added.

The original Member/resource integration passes unchanged recovery, an H1 selection of another complete H0 pair, and refusal of new H1 native owners: three cases and 147 assertions. Nine complete Service resource/recovery files pass eighteen cases and 399 assertions. The genuine Hosted composition passes 85 assertions after its completed model task selects cloud resources and pauses the same Session; this includes a genuine repeated pause, signature and operation corruption, a valid signature over a foreign payload, original history and zero replay. That scenario does not certify a historical completed grant that itself executed with the cloud pair. The three complete Runtime files pass 21 cases and 496 assertions, and the three owning TypeScript checks pass. Final-candidate canonical, actual PostgreSQL and exact-head CI verification remain separate acceptance evidence. See [the incident](../../../postmortem/0220-selected-cloud-session-history-lacked-recovery-owners.md).
