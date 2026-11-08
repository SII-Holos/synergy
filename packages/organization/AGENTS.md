# Organization Service

Own organization identity, project authorization, resource grants, shared projections, command forwarding and handoff coordination. The service never runs Agent loops and never imports a full Runtime preset. Runtime execution records remain with their execution owner.

Use an explicit isolated Storage Handle, the central migration runner and owner-local storage keys. Authorization and durable admission share the organization transaction; Runtime receipt is a separate fact. Do not persist private member Session bodies in forwarding records. Keep all read paths and downloads behind current authorization.

Route object actions through `authorization.ts` inside the caller's transaction or snapshot. Resolve stored ownership before applying roles and deny unknown actions. Archived projects permit stopping, not new execution. Credential authentication and one-time token consumption belong to `auth/`; do not duplicate the authorization matrix in routes or the Runtime adapter.

Session directory reads use current project access and canonical creator visibility. Page authorized creator/shared indexes before loading records; administrator capacity exposes counts only. Creation commits directory reservation with admission; metadata is never a Runtime receipt or execution grant. Verify rollback, revocation and mixed-owner pagination in `test/session-directory.test.ts`.

Client grants bind the first-party login, exact registered callback and deployment identity. Keep authorization-code consumption and token creation atomic. Refresh replay must commit grant revocation before returning its error. Expired proof may revoke its own login, never authorize business access. Cross-origin clients use access tokens, never ambient cookie credentials. Preserve the separate generated organization client and verify real HTTP exchange in `test/client-auth.test.ts`.

The optional Web adapter serves the built authorization document and local assets only. Keep API failures out of HTML fallback, restrict its scripts and connections to the organization origin, and preserve popup opener communication. Verify `test/web.test.ts` and the Web authorization browser suite after changing these headers or paths.

Tests live under `test/` and use real temporary storage. Run `bun run typecheck` and focused `bun test` suites, then root dependency, package and generated-contract checks. All service processes use a dedicated Home and explicit ports; preserve the active user Runtime.

The component contributes configuration schemas and lazy CLI commands. Register service migrations inside the independent service context, never in the surrounding Agent Runtime. Commands declare owner initialization and require an explicit absolute Home before writes. Read only the canonical organization domain using its owning schema; do not invoke Agent configuration resolution. Keep initialization secrets out of argv and stdout. Verify `test/configuration.test.ts`, `test/cli.test.ts` with real child processes and `test/service.test.ts` for migration and lifecycle isolation.

The machine bridge owns authenticated sockets and durable connection epochs. Use the service context for every native WebSocket callback that accesses storage. Check current registration and account state, carry liveness guards through SQL commit, and fence superseded sockets before accepting further frames. Heartbeat expiry is availability only. Verify real sockets, concurrent authentication, revocation, restart and malformed frames in `test/runtime-connection.test.ts`.

Create service signing identity through its central startup migration. Validate the deployment and key pair before readiness; completed migration with missing or damaged credentials requires recovery, never automatic replacement. Publish only the public identity in the authenticated bridge. Verify upgrade, restart and corruption in `test/signing.test.ts`.

Command admission derives actors from validated credentials and checks current roles and live connection inside its writer. Keep authorization, dispatch and Runtime acceptance separate; a blocked new request is definitely unsent. Retain issued skip proofs across reconnect and verify reconciliation in `test/command-admission.test.ts`. Metadata records never authorize automatic replay.

Forward active requests through bounded exchanges; distinguish dropped, enqueued and unknown sends. Never replay after reconnect. Observe cancellation independently; recheck access and binding after replies. Verify capacity, late receipts, skip recovery and generated HTTP in `test/command-forwarding.test.ts` and Presets integration.
