# Organization Protocol

Own strict, versioned DTOs and bridge messages shared by the organization service, Runtime adapter and clients. Keep this package independent of execution, storage, HTTP hosts and user-interface implementations. Unknown protocol versions and fields fail validation; release build strings do not decide protocol compatibility.

Tests live under `test/`. Run `bun run typecheck` and `bun run test` here; verify mounted OpenAPI and regenerate the SDK when a schema becomes API-visible.

Machine proofs bind a strict purpose and all authority-bearing claims with a versioned canonical encoding. Preserve signature-domain separation, validate before verification, and test altered identity, epoch and capability claims with real keys. Never make build-version strings an authorization decision.

Reuse the portable account actor schema from Util. Command permits bind the logical request, actor, deployment, target, epochs, sequences and finite signing window; signature validity alone does not establish current execution admission. Preserve existing proof bytes when sharing signing primitives, and verify compiled Node imports across package boundaries.

Hash the complete strict input and target. Keep skip authorization in a separate signature domain and bind its original attempt. Test UTF-8 byte bounds, changed bodies and targets, and immutable accepted-effect identity independently of attempt rejection.

Decision digests bind the native pending identity, source Session and answer. Accepted winners omit question answers and distinguish expired requests. Verify `test/decision-command.test.ts`.

Current execution observations belong beside immutable receipts. Bind their root and observation window to acceptance; reject observation fields in durable results.

Resource definitions declare fixed supported protocols and portable model capabilities. Keep upstream configuration, public descriptors and secret input distinct. No arbitrary Runtime options, caller-selected ownership changes or transport-routing credential headers. Verify strict contracts in `test/resource.test.ts`.

Execution proofs bind the full accepted task receipt, exact native root and finite machine authority in a separate signature domain. Keep selection revisions and grant state distinct from command acceptance. Verify altered claims and bounded contracts in `test/execution.test.ts`.

Resource-description proofs establish accepted intake before materialization. Keep them separate from root authority and validate descriptor order, kinds and secret exclusion.

Gateway capabilities bind one call and finite resource limits. Keep machine request and worker invocation signatures separate. Verify token bounds, altered targets and signature separation in `test/gateway.test.ts`.

Shared synchronization DTOs are strict and generation-bound. Explicitly shared transcripts carry portable message/part DTOs and content references; private bodies remain Runtime-owned. Reject local paths, credentials and permanent asset URLs. Keep batches contiguous and payload-hashed, with explicit cursor/checkpoint semantics. API-visible changes require mounted OpenAPI and organization SDK regeneration.

Private field consumption validates the same wire identities, versions, offsets and original-content state through `Read.matches`. Keep `read-content` stateless and transport-independent: typed read, awaited append and incremental hash ports only. Bound each chunk, propagate cancellation and retain partial-original status through completion. Preparation returns its progress and verified prefix offset without polling or finalizing the digest; resumption retains the same sink and hash state. Sinks publish only after the final digest succeeds.

Desktop content saves bind an immutable field to the captured Session binding. Reject renderer-selected URLs, native paths and credentials; return preparation separately from saved receipts and retain partial-original state.

Publications use immutable file manifests and exact item/version/hash references. Selection updates bind a stable request, exact target, ordered page identities and a final expected sequence; page limits never become lifetime item quotas. Separate project artifact visibility from source Session visibility. Machine knowledge access reuses signed accepted execution authority and the current Session's selected versions. Page metadata and bound byte chunks without imposing a lifetime object quota.
