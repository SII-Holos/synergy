# Organization Protocol

Own versioned service/Runtime/client DTOs; exclude execution, storage, HTTP and UI. Reject unknown versions/fields; build strings never decide compatibility.

Run `bun run typecheck` and `bun run test`; verify mounted OpenAPI and regenerate SDKs when a schema becomes API-visible.

Handoff proofs/plans bind purpose, ownership, operations, watermarks and connections. Validate signature domains. Distinguish file hashes from directory CAS receipts. Refresh authority; reject system-driven human controls. Test tampering/completion. Ranges never authorize arbitrary content.

API token schemas separate one-time secrets from metadata and bind explicit project/operation/expiry scope. Trusted routes select purposes; token scope never replaces current authorization. Reuse the portable account actor schema from Util, including optional signed token attribution. Command permits bind the logical request, actor, deployment, target, epochs, sequences and finite signing window; signature validity alone does not establish current execution admission. Preserve existing proof bytes when sharing signing primitives, and verify compiled Node imports across package boundaries.

Hash the complete strict input and target. Keep skip authorization in a separate signature domain and bind its original attempt. Test UTF-8 byte bounds, changed bodies and targets, and immutable accepted-effect identity independently of attempt rejection.

Desktop bridge versions require revision-bound logout phases; test old-request rejection in `test/desktop.test.ts`. Command stream frames separate transfer nonces from canonical logical IDs. Reuse command payload limits and Runtime chunk sizes; verify strict input/reply-only envelopes in `test/command-stream.test.ts`.

Decision digests bind request, source and answer. Interaction reads page pending owners and value-free winners. Bind permits to queries; verify decision-command/interaction suites.

Current execution observations belong beside immutable receipts. Bind their root and observation window to acceptance; reject observation fields in durable results.

Resource definitions declare fixed supported protocols and portable model capabilities. Keep upstream configuration, public descriptors and secret input distinct. No arbitrary Runtime options, caller-selected ownership changes or transport-routing credential headers. Verify strict contracts in `test/resource.test.ts`.

Execution proofs bind accepted task receipts, native roots and finite machine authority separately from command acceptance. Require explicit native/cloud infrastructure; classify resource roles and exclude infrastructure from business gateways. Verify altered claims and strict contracts in `test/execution*.test.ts`.

Resource-description proofs establish accepted intake before materialization. Keep them separate from root authority and validate descriptor order, kinds and secret exclusion.

Gateway capabilities bind one call and finite resource limits. Keep machine request and worker invocation signatures separate. Verify token bounds, altered targets and signature separation in `test/gateway.test.ts`.

Shared synchronization DTOs are strict and generation-bound. Notifications bound frames/audience/sequences; reconnect never replays. Explicitly shared transcripts carry portable message/part DTOs and content references; private bodies remain Runtime-owned. Reject local paths, credentials and permanent asset URLs. Keep batches contiguous and payload-hashed, with explicit cursor/checkpoint semantics. API changes require mounted OpenAPI and SDK regeneration.

Private field consumption validates the same wire identities, versions, offsets and original-content state through `Read.matches`. Keep `read-content` stateless and transport-independent: typed read, awaited append and incremental hash ports only. Bound each chunk, propagate cancellation and retain partial-original status through completion. Preparation returns its progress and verified prefix offset without polling or finalizing the digest; resumption retains the same sink and hash state. Sinks publish only after the final digest succeeds.

Desktop saves bind immutable fields or attachments to the captured Session binding. Reject renderer-selected URLs, native paths and credentials; return preparation separately from saved receipts and retain partial-original state.

Publications use immutable file manifests and exact item/version/hash references. Selection updates bind a stable request, exact target, ordered page identities and a final expected sequence; page limits never become lifetime item quotas. Separate project artifact visibility from source Session visibility. Machine knowledge access reuses signed accepted execution authority and the current Session's selected versions. Page metadata and bound byte chunks without imposing a lifetime object quota.
