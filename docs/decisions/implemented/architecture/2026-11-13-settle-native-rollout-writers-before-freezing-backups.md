# Decision Record: Settle native Rollout writers before freezing backups

Status: implemented

## Problem

A completed Hosted model task retains its original Rollout recovery checkpoint until exclusive settlement. Runtime shutdown can attempt that checkpoint after backup maintenance freezes the namespace or permanently retires its Home. Settling before bridge and native process drainage also allows later accepted callbacks to invalidate the checkpoint. A paused model stream can retain an unresolved execution generation even after Rollout recording itself has settled.

## Decision

Register the existing Rollout recovery owner as the final native maintenance contribution, after Session workers, organization bridge/resource observers and native process tails. Its drain calls the original settlement implementation. Inspection requires every touched pending owner to have settled; failure preserves the original pending facts and prevents a drainage receipt. Frozen shutdown then performs no additional recovery write. Untouched historical owners retain their existing deferred recovery semantics.

Hosted native capture requires the registered execution-cleanup owner's completed startup migration and reads every canonical cleanup entry through bounded pages. It verifies original settlement references and rejects pending generations before producing native evidence. It does not infer coverage from an empty derived pending index, perform a lazy upgrade, close an unknown gateway or modify a retained execution outcome. Successful confirmed links retain their existing semantics; unknown settlement still requires the service's original signed dispatch horizon.

The cleanup check belongs to native capture rather than a maintenance inspector. Refused capture must allow ordinary maintenance release to reconnect the same bridge, preserve the Session's paused binding and leave its original Home unretired. It does not create retirement evidence or authorize restored execution.

## Alternatives considered

**Settling when LoopJobs finish** precedes later bridge and native output callbacks, leaving another writer after the checkpoint.

**Allowing shutdown recovery writes through a frozen source** weakens the immutable backup and permanent retirement guards.

**A pending-generation maintenance inspector** can prevent the release that reconnects the original cleanup observer. Native capture rejects the unsupported backup while ordinary release remains available.

## Consequences

Completed model EOF and actual native release can be captured without a late shutdown write. An interrupted paused stream remains explicitly unavailable for native recovery and retains its original evidence. Service reconstruction of task command/grant/gateway history and independently authorized recovery Continue remain separate; this change does not enable them or automatic replay.

## Verification

Harness `test/session/rollout-pending.test.ts` holds a real maintenance tail that writes its original Rollout before settlement, and checks that a settlement failure preserves pending state and refuses freeze. Organization Runtime `test/backup/native.test.ts` uses actual TLS enrollment, signed model admission and gateway streams: normal EOF drains before capture; signed Pause followed by a real upstream interruption rejects capture, preserves canonical cleanup and binding facts, permits maintenance release and observes the original bridge reconnect before normal shutdown.
