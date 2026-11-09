# Organization Service

Own organization identity, authorization, resources, projections, forwarding and handoff coordination. Never run Agent loops or import Runtime presets; execution records stay with their owner.

Use an isolated Storage Handle, the central migration runner and owner-local storage keys. Authorization and admission share the organization transaction; Runtime receipt is a separate fact. Do not persist private member Session bodies in forwarding records. Keep read paths and downloads behind current authorization.

Route object actions through `authorization.ts` inside the caller's transaction or snapshot. Resolve stored ownership before applying roles and deny unknown actions. Archived projects permit stopping, not new execution. Credential authentication and one-time token consumption belong to `auth/`; do not duplicate the authorization matrix in routes or the Runtime adapter.

Session directory reads use current project access and canonical creator visibility. Page authorized creator/shared indexes before loading records; administrator capacity exposes counts only. Creation commits directory reservation with admission; metadata is never a Runtime receipt or execution grant. Verify rollback, revocation and mixed-owner pagination in `test/session-directory.test.ts`.

Client grants bind the first-party login, exact registered callback and deployment identity. Keep authorization-code consumption and token creation atomic. Refresh replay must commit grant revocation before returning its error. Expired proof may revoke its own login, never authorize business access. Cross-origin clients use access tokens, never ambient cookie credentials. Preserve the separate generated organization client and verify real HTTP exchange in `test/client-auth.test.ts`.

The optional Web adapter serves the built authorization document. Keep API failures out of HTML fallback, restrict scripts and connections to the organization origin, and preserve popup communication. Verify Web tests after changing these headers or paths.

Tests in `test/` use isolated storage, Homes and ports; preserve active Runtimes.

The component contributes configuration schemas and lazy CLI commands. Register migrations inside the service context; commands require an absolute Home before writes. Read only the organization domain; keep initialization secrets out of argv and stdout. Verify configuration, CLI and service migration tests.

The machine bridge owns authenticated sockets and connection epochs. Use the service context for every native WebSocket callback that accesses storage. Check registration and account state, carry liveness guards through SQL commit, and fence superseded sockets before accepting frames. Heartbeat expiry is availability only. Verify sockets, concurrent authentication, revocation, restart and malformed frames in `test/runtime-connection.test.ts`.

Create signing identity through the startup migration; validate deployment and keys before readiness. Damaged completed credentials require recovery, never replacement. Publish public identity only. Verify `test/signing.test.ts`.

Command admission derives actors from validated credentials and checks current roles and live connection inside its writer. Keep authorization, dispatch and Runtime acceptance separate; a blocked new request is definitely unsent. Retain issued skip proofs across reconnect and verify reconciliation in `test/command-admission.test.ts`. Metadata records never authorize automatic replay.

Forward active requests through bounded exchanges; distinguish dropped, enqueued and unknown sends. Never replay after reconnect. Observe cancellation independently; recheck access and binding after replies. Verify capacity, late receipts, skip recovery and generated HTTP in `test/command-forwarding.test.ts` and Presets integration.

Keep resource secrets separate and atomically update grant occupancy. Bind with native evidence; inspect retention without reacquiring resources. Release drained generations; retain receipts and fence prior capabilities. Gateway calls recheck authority, commit before transmission and retain capacity through disposal. Preserve native budgets. Verify resource, execution-grant, retention, release, migration and gateway tests, plus Presets integration.

Shared Session synchronization belongs to the service boundary. Keep creator-only share CAS, generation fencing, visibility indexes, bounded safe projections and checkpoint/idempotency writes in one organization transaction. Read events through current authorization; never persist private transcript bodies, local paths or permanent asset URLs. Verify `test/sharing.test.ts` and regenerate the organization SDK after changing the sync protocol or routes.
