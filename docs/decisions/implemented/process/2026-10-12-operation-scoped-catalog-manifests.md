# Decision Record: Operation-scoped workspace manifests for the CLI catalog

Status: implemented

## Problem

Static CLI registration and command-source discovery repeatedly scan workspace manifests for the same package imports, including unresolved external and Node imports. A complete generation performs 16,204 manifest reads over only 34 files, in addition to 372 source reads. Repeated serial I/O consumes the byte-stability test's existing execution budget without contributing new source facts.

## Decision

[`createWorkspaceModuleResolver()`](../../../../script/gen/shared.ts) owns a path-keyed map of parsed manifest Promises. Each [`generate()`](../../../../script/gen/gen-cli-reference.ts) creates a new resolver and shares it between command registration and all command-source walks. Concurrent and repeated requests join the same read, including a rejected read. Independent generations create new readers, so manifest edits and repaired files are observed without invalidation machinery.

Workspace traversal order, export-key matching order, `bun` → `types` → `import` priority and file-candidate probing remain unchanged. Missing exports or source candidates still resolve to `null`; manifest read and parse errors still reject. Sources, ASTs, resolved module paths and generated output are not cached. The existing standalone `resolveWorkspaceModule()` export retains a fresh resolver per call for its other consumers.

## Alternatives considered

**Read every manifest for every specifier.** This preserves freshness but repeats the same I/O thousands of times within a single static operation; the operation needs one parsed observation per manifest, not per import.

**Retain a process-global manifest cache.** This would reuse reads across generations but hide edits and repaired files unless another invalidation mechanism were added. The generation itself is the useful lifetime.

**Increase the byte-stability timeout or add retries.** This would permit the amplified work without bounding it. The existing two full CLI generations and their 5000ms test budget remain unchanged.

## Consequences

A complete generation reads 34 manifests and 372 sources, reducing total reads from 16,576 to 406 with byte-identical output and identical results for all 504 unique resolver inputs in the measured corpus. These counts are work bounds, not portable timing claims or a reconstruction of an earlier timeout.

The resolver retains each parsed manifest and its Promise until the owning operation completes. Manifest edits during that operation are intentionally not observed after the first read; a new generation observes them. [`gen-catalogs.test.ts`](../../../../test/script/gen-catalogs.test.ts) verifies concurrent and repeated read bounds on real files, conditional and wildcard exports, static traversal and changed output after a manifest edit between independent generations. Existing catalog correctness and byte-stability coverage is retained.
