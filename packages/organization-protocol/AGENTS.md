# Organization Protocol

Own strict, versioned DTOs and bridge messages shared by the organization service, Runtime adapter and clients. Keep this package independent of execution, storage, HTTP hosts and user-interface implementations. Unknown protocol versions and fields fail validation; release build strings do not decide protocol compatibility.

Tests live under `test/`. Run `bun run typecheck` and `bun run test` here; verify mounted OpenAPI and regenerate the SDK when a schema becomes API-visible.

Machine proofs bind a strict purpose and all authority-bearing claims with a versioned canonical encoding. Preserve signature-domain separation, validate before verification, and test altered identity, epoch and capability claims with real keys. Never make build-version strings an authorization decision.

Reuse the portable account actor schema from Util. Command permits bind the logical request, actor, deployment, target, epochs, sequences and finite signing window; signature validity alone does not establish current execution admission. Preserve existing proof bytes when sharing signing primitives, and verify compiled Node imports across package boundaries.
