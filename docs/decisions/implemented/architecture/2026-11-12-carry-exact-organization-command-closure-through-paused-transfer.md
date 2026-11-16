# Decision Record: Carry exact organization command closure through paused transfer

Status: implemented

## Problem

Native Session history alone does not retain the organization's input deduplication or accepted resource receipts. Copying only the Session subtree can lose those identities, while copying the whole command namespace includes unrelated Sessions. A target that can read Core schema 2 can also lack the organization binding adoption required to execute or read the imported Session safely. Historical source release entries must not become work for the destination's release observer.

## Decision

The organization Runtime owns its command record schemas and a versioned `organization-runtime` portability contribution. The Session schema contribution declares this required owner when its fields are present. Source selection and target Core validation require the actual registered compatible reader; a build version or Core schema alone does not establish compatibility.

The organization owner captures the exact Session-indexed command family under a native Storage snapshot and spools bounded records to a private temporary file. Its Session request index identifies the required immutable logical requests and associated release entries. Runtime-wide intake counters, other Sessions, credentials and trust rules are excluded. A header binds the handoff, root, Session, canonical source organization binding, closed command watermark and record count. Native Core remains the owner of Session history and Inbox input.

Target validation reads only its own staged partition and its declared same-member Core metadata dependency. It verifies the exact source binding, complete command slots and their attempts, request indexes and logical requests, accepted reception evidence, skip proofs and accepted native root/actor/grant identities. Every attempt and skip is at or below the declared watermark and has a closed sequence position. A late rejected attempt may share another attempt's already closed position, as native intake permits; accepted/skipped attempts and skip receipts must own their exact slot. The source domain checks those native positions before final freezing, independently of the caller's barrier. Release Runtime, epoch and acceptance time match the original acceptance. The original accepted attempt contains that exact permit. Unknown storage keys, incomplete closure, another Session and conflicting logical identities fail before canonical publication.

Publication runs under the verified service activation and native epoch transaction. Core first adopts the organization binding through its schema owner. The command owner verifies that adoption, publishes its prepared records and changes only the current command-state driver and epoch. Original permits, actors, input/root identities, request results and historical release entries remain unchanged. The release observer selects pending entries belonging to its own current Runtime/epoch; imported source entries cannot release or bind a destination grant.

Native task release creation follows the first logical acceptance and its original permit. A newly authorized attempt returning that receipt cannot replace the release's grant, admission, actor or settled state. New logical tasks still create independent entries. Existing inconsistent historical rows remain blocked rather than being repaired during reception.

This adapter does not issue a new execution grant, authorize Continue, rewrite a historical receipt into current authority or drive the organization machine protocol. Resource rebind/release, operator recovery, old-member retirement and production dispatch remain distinct integrations. A conflicting historical mutable release state remains blocked rather than guessed or overwritten.

## Alternatives considered

**Copy every organization command record.** This transports unrelated private history and replaces Runtime-wide ownership with a Session operation.

**Retarget the original accepted permit and actor.** This destroys reception attribution and makes copied history look like a newly authorized destination command.

**Require only the Core reader version.** That accepts a target without organization adoption and command closure support.

**Let the destination observer process every imported pending release.** A source grant would then be presented under the destination machine identity and current execution binding.

## Consequences

A real multi-Home fixture captures signed native task intake, expired reception followed by a skip and a late rejected attempt at another attempt's closed position. It rejects a source missing the required owner and an old target before body reads, and imports paused history with original identities. Consistently rehashed transport variants reject omitted requests/releases/slots, future rejected attempts with matching request/index/skip records, a skip attached to another attempt's slot, changed release binding/acceptance, changed accepted permit, foreign Session identities and injected trust keys. A real native sequence-gap receipt also blocks source preparation with an ineffective caller barrier, leaving the source draining without a package. Ordinary binding/adoption and command replay, rollback, reconnect and admission tests remain regression coverage. See `packages/organization-runtime/test/session-transfer.test.ts` and [Session portability](../../../architecture/session-transfer.md).
