# Organization Service

Own organization identity, project authorization, resource grants, shared projections, command forwarding and handoff coordination. The service never runs Agent loops and never imports a full Runtime preset. Runtime execution records remain with their execution owner.

Use an explicit isolated Storage Handle, the central migration runner and owner-local storage keys. Authorization and durable admission share the organization transaction; Runtime receipt is a separate fact. Do not persist private member Session bodies in forwarding records. Keep all read paths and downloads behind current authorization.

Tests live under `test/` and use real temporary storage. Run `bun run typecheck` and focused `bun test` suites, then root dependency, package and generated-contract checks. All service processes use a dedicated Home and explicit ports; preserve the active user Runtime.
