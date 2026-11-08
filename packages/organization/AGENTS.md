# Organization Service

Own organization identity, project authorization, resource grants, shared projections, command forwarding and handoff coordination. The service never runs Agent loops and never imports a full Runtime preset. Runtime execution records remain with their execution owner.

Use an explicit isolated Storage Handle, the central migration runner and owner-local storage keys. Authorization and durable admission share the organization transaction; Runtime receipt is a separate fact. Do not persist private member Session bodies in forwarding records. Keep all read paths and downloads behind current authorization.

Route object actions through `authorization.ts` inside the caller's transaction or snapshot. Resolve stored ownership before applying roles and deny unknown actions. Credential authentication and one-time token consumption belong to `auth/`; do not duplicate the authorization matrix in routes or the Runtime adapter.

Client grants bind the first-party login, exact registered callback and deployment identity. Keep authorization-code consumption and token creation atomic. Refresh replay must commit grant revocation before returning its error. Expired proof may revoke its own login, never authorize business access. Cross-origin clients use access tokens, never ambient cookie credentials. Preserve the separate generated organization client and verify real HTTP exchange in `test/client-auth.test.ts`.

The optional Web adapter serves the built authorization document and local assets only. Keep API failures out of HTML fallback, restrict its scripts and connections to the organization origin, and preserve popup opener communication. Verify `test/web.test.ts` and the Web authorization browser suite after changing these headers or paths.

Tests live under `test/` and use real temporary storage. Run `bun run typecheck` and focused `bun test` suites, then root dependency, package and generated-contract checks. All service processes use a dedicated Home and explicit ports; preserve the active user Runtime.

The component contributes configuration schemas and lazy CLI commands. Register service migrations inside the independent service context, never in the surrounding Agent Runtime. Commands declare owner initialization and require an explicit absolute Home before writes. Read only the canonical organization domain using its owning schema; do not invoke Agent configuration resolution. Keep initialization secrets out of argv and stdout. Verify `test/configuration.test.ts`, `test/cli.test.ts` with real child processes and `test/service.test.ts` for migration and lifecycle isolation.

The machine bridge owns authenticated sockets and durable connection epochs. Use the service context for every native WebSocket callback that accesses storage. Check current registration and account state, carry liveness guards through SQL commit, and fence superseded sockets before accepting further frames. Heartbeat expiry is availability only. Verify real sockets, concurrent authentication, revocation, restart and malformed frames in `test/runtime-connection.test.ts`.
