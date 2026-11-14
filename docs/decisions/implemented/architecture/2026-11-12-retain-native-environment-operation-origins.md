# Decision Record: Retain native Environment operation origins

Status: implemented

## Problem

An Environment operation records its allocation and command digest but previously had no canonical Session, root, Run or tool owner. A current Session selection cannot discover operations retained under an earlier Environment. An allocation or connection can also remain pending before an execution receipt exists, allowing an empty operation index to look drained. After a Session pauses, a connection accepted earlier must not start its first physical command.

## Decision

New execution starts require an explicit native Session origin or an opaque capability minted by a registered Host component. Session origins carry separate root and Run identities, assistant message, tool call and tool name. The Session owner validates its own persisted Session, root message, Run and existing tool-part locator before resource admission and execution dispatch. Runtime, Store and artifact configuration bind captured capabilities. Caller-provided Host labels, copied capabilities and new legacy-unknown inputs are rejected. `environment/origin` is the public composition boundary.

The tool resolver, Bash and user shell forward their actual native origins through Resources and Process to Execution. Resource selection metadata remains a bodyless destination; its resolved origin is a native capability, not persisted selection authority. API-only operations require no execution origin and acquire no resources. Host components decide whether an invocation is a shared service or part of a current Task; a Host label cannot replace a missing Task capability.

Execution records use a strict version-2 envelope. The owning central migration physically upgrades validated previous records, retains their original facts and unknown owner fields, and labels missing historical origin as `legacy-unknown`. It does not guess lineage, mint a new Run or replay a command. A previous flat-record reader rejects the envelope. The organization Home reader independently fences an origin-unaware worker before it can start a new operation against an empty database.

Session/root and active Environment indexes contain canonical operation locators. Every operation writer updates them in the same transaction. Startup clears incomplete derived rows, rebuilds in bounded pages and seals coverage only after the full canonical scan. Queries require that owning coverage, validate each locator against its current record and bind deferred iterators to their creating Store. Without coverage, a bounded key-only presence check may prove an empty database; existing records require migration. Completed history keeps its original Session index after Environment deselection. Active legacy operations with unknown Session ownership block a freeze of their selected Environment, without assigning their private history to that Session.

Finite resource preparation and execution requests retain exact native request ownership before their first asynchronous work. Source drainage waits outside the SQL writer; cancelling that observer does not cancel the provider. Epoch freeze reads canonical Session operation state and checks pending native requests again at commit. Preparation revalidates the original Task after connection and releases its admission when that authority closed. If an execution receipt was already submitted, a failed dispatch check sends cancellation through the original Executor. Only confirmed terminal cancellation with `effectsStarted: false` permits immediate native saving and use release. Unknown or failed cancellation keeps the original receipt for reconciliation.

POSIX workspace-write sandbox preparation also materializes the approved original Session temporary child on the actual Executor. The shared naming owner recognizes the carried path without replacing its controller PID. Descriptor-relative creation retains the selected Workspace and refuses symbolic or replaced parents; the original preparing receipt and operation guards cover the effect. It neither creates arbitrary writable roots nor weakens protected-create monitoring. A prepared retry only verifies the existing directories and original policy. The native preparation and anchored directory suites distinguish this filesystem fact from actual Linux helper execution.

## Alternatives considered

**Infer ownership from Scope, working directory or an operation hash.** These are shared destinations or opaque identities and cannot prove a Session, root or tool lineage.

**Add optional origin fields to the previous record.** Its reader discards unknown fields and could continue operating without preserving provenance. The strict envelope and independent Home reader fence close both old-record and empty-database admission paths.

**Treat an empty derived index as proof of drainage.** Missing migration coverage or a request waiting before receipt publication makes that inference false. Coverage and exact native pending lifetimes are separate evidence.

**Drop an undispatched receipt when authority closes.** The original Executor owns cancellation and replay exclusion. A durable no-effect cancellation proves absence of physical execution; a controller assertion does not.

## Consequences

Current native execution gains explicit provenance and fail-closed freeze checks without a second execution catalog. Index rebuilding consumes startup work; an incomplete upgrade blocks dependent reads. Historical unknown records remain readable, while active uncertain ownership requires reconciliation.

This unit does not implement the `session-environments` portable owner, cloud allocation mappings, resource-selection consent or complete Environment Use ownership. The existing portability presence gate still rejects transfers requiring that unavailable owner. It neither stops an already running old worker nor certifies external process termination. Host callers must use their composition-owned capability; remaining consumer integration is tracked separately.

## Verification

Harness `test/environment/{execution-origin,origin}.test.ts` uses real native Session/Run/tool records, SQLite Stores, held provider requests, cold physical migration, missing coverage, forged capabilities and deferred iterator escapes. Execution, resource and maintenance suites retain original receipt, restart, checkpoint and lost-ack behavior. Local Runtime `test/environment/bash.test.ts` holds the actual native provider connection after submission, pauses the Session, then verifies no marker was written and the original no-effect cancellation settled. User-shell and resolver suites verify canonical origins beside real command output and file saving. See [the pending-admission postmortem](../../../postmortem/0121-environment-admission-outlived-session-authority.md).

Configuration fixtures retain object identity while replacing the Store namespace or artifact blob port, writer identity and clock. They require both the captured origin and its deferred Session index to reject, independently of each other's guard.

Resolver and Processor fixtures create a real native user root, assistant and Run before invoking the original tool path. The shared `withRun` fixture supplies this lifetime without nesting another tool record around a Processor-owned invocation; direct backend fixtures retain `withToolRun`. Transfer fixtures complete child owner preparation before freezing the aggregate root, and cancellation observers await the original parent-abort owner rather than an unrelated exported method.

Installed composition fixtures construct these records through the published Session, ledger and tool leaves, without importing development test helpers. Resource concurrency fixtures acquire their actual Host origin before waiting at a materialization barrier. Fixtures using Cortex register its Session runtime so retained callbacks close before the underlying Runtime is disposed.

Direct Bash adapter fixtures submit their exact command patterns to the original PermissionNext owner; a caller authorization flag cannot suppress that check. Native supervisor environment fixtures open the real Local Runtime with its Store and coordinator. Their selected launcher dispatches the storage-worker role to the published SQLite worker in the same IPC process and records supervisor environment evidence only for the owned-process role. Original command output, environment separation, physical completion and cleanup assertions remain required. Transport refusal checks retain the original input identity and final-saving hold instead of accepting an arbitrary failure.
