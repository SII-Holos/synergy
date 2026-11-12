# Decision Record: Reopen fixed recovery policy after source retirement

Status: implemented

## Problem

Source retirement is permanent, while its original current-source callback and both native handles can close before target policy publication completes. A target may still contain H0 or may already have committed H1 without returning its receipt. Repeating live source capture would require reopening a retired control plane. Creating another inactive signing key would also replace material already bound to the original target request.

## Decision

`OrganizationRecoveryAuthority.reopen` authenticates existing inactive material only. It shares the original installation, committed import, recovery-held, archived H0 namespace, native owner, signing identity and envelope validation with preparation. It never creates a directory or key and never calls the provider's `current` key method. Missing material refuses. Ordinary `prepare` retains its original covered-H0 requirement before any key generation.

Reopening accepts a covered later target head only in the same journal, namespace, contract, baseline and start identity. The canonical current chain's first entry after H0 must point to the archived H0 tail, or the current head must equal H0 exactly. This authenticates the existing inactive material's original history; it grants neither current-policy authority nor execution.

`OrganizationRecovery.reconstructCold` consumes an actual opaque receipt from the original source's restricted retirement handle. The source owner freshly verifies its permanent reservation, physical Home, primary Store and process lock. The original reference pins the exact H1 namespace/native hashes, checkpoint, H0 anchor and target installation/request. The coordinator validates the full native archive and complete covered namespace through the existing native and Journal owners. It does not mint another Current source or accept a caller's checkpoint as authority.

The source receipt owner retains accepted inspection work until its callback ends, including when the caller returns without awaiting it. Its pure lifetime/configuration guard can run at the actual target commit without switching to the source Runtime or doing physical I/O. Source shutdown waits for that read. An observer's rejected read remains on its original promise, while failed mandatory native fencing still reports through shutdown.

Warm and cold reconstruction share the same original-target adoption and receipt transaction. Both H0 rollback retry and already-applied H1 receipt retry reconstruct full raw facts, retain the target hold and preserve the original inactive bytes/key. No additional persisted recovery phase is introduced.

## Alternatives considered

**Recreate a Current source on the retired Home.** That would reopen a control plane already permanently fenced and replace the original source evidence.

**Generate another inactive key when H1 is present.** Missing original material cannot authorize key replacement or preserve the original target request's identity.

**Use an existing policy receipt to authenticate inactive material.** It would couple independent material authentication to the policy transaction that needs that material, and could prevent H0 rollback recovery.

**Let source shutdown ignore an outstanding read.** The target's final commit could outlive the physical source evidence it relies on.

## Consequences

Recovery can finish from the original fixed archives after source and target handles close, without changing deployment, active signing or the recovery-held target. Current native settings, member/hosted/resource unique-writer reconciliation, fresh authority publication and paused-ready startup remain required before full recovery acceptance.

The real encrypted service fixture in `packages/organization/test/backup/authority.test.ts` closes the original callbacks and handles, opens Source4 and Target3, cancels the final cold target write, verifies H0 rollback, reopens the source and retries H1, then closes both sides and retries the original H1 receipt. It checks an expired inspection, copied receipt, wrong pinned archive, missing inactive material at H1, unchanged material bytes and zero key generation/provider-current calls. Holding the final write while an unawaited read is accepted proves shutdown drainage rather than a metadata-only retry.
