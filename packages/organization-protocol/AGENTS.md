# Organization Protocol

Own strict, versioned DTOs and bridge messages shared by the organization service, Runtime adapter and clients. Keep this package independent of execution, storage, HTTP hosts and user-interface implementations. Unknown protocol versions and fields fail validation; release build strings do not decide protocol compatibility.

Tests live under `test/`. Run `bun run typecheck` and `bun run test` here; verify mounted OpenAPI and regenerate the SDK when a schema becomes API-visible.
