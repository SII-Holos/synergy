# Decision Record: Bound platform publication payloads

Status: implemented

## Problem

Complete standalone runtime seeds include the transitive dependency tree. ONNX packages contain unused native backends for multiple operating systems and duplicate Web WASM backends, even though the packaged Library selects its own bundled WASM backend. Platform publication can exceed npm's accepted request size after module candidates have already been published.

## Decision

Full seed assembly requires the bundled Library embedding module, WASM module and WASM binary before removing unused native libraries under `onnxruntime-node/bin`, dependency `onnxruntime-web/dist` WASM files, JavaScript/TypeScript source maps and npm ignore metadata. Linux assembly also excludes dependency packages whose declared libc does not match the target. The ast-grep platform package retains the canonical `ast-grep` executable resolved by [Code tools](../../../../packages/code-tools/src/ast-grep/cli.ts), while its duplicate `sg` executable is omitted only when that canonical file exists. Assembly performs this selection before generation and runtime inventories are sealed. It preserves the bundled backend, executable modules, manifests, types, license notices and unrelated runtime resources. Core seeds and published module archives are unchanged.

Candidate preparation packs every platform and the product wrapper before any npm publication, checks those archives and the module archives against a 190 MiB compressed-size budget, and uploads those same checked files. This budget accommodates the retained Windows executable and native libraries; its base64 representation is below 254 MiB before publication metadata. It is a project budget, not a claim about npm's service limit. Packed platform archives are extracted and checked against the complete runtime inventory, so npm filtering cannot omit a sealed file unnoticed. The shared publisher rejects missing or oversized archives as well.

Recovery permits these explicitly named publication and seed-assembly files while continuing to reject workspace module compilation, manifests, dependency locks, product source and native build changes. Accepted module versions remain immutable.

## Alternatives considered

**Retry the unchanged upload.** An oversized request is deterministic; repeating it cannot reduce the payload and delays recovery after partial publication.

**Remove arbitrary dependency files or required product assets.** Package ownership and the selected embedding backend provide a narrow removal rule. Generic source or runtime pruning could break dynamic imports and optional capabilities.

**Download the complete runtime during npm postinstall.** That introduces another installation path and changes offline startup and integrity handling. Keeping the complete validated runtime in the platform package preserves the existing installation behavior.

## Consequences

Standalone artifacts use the existing bundled embedding backend without distributing alternative ONNX native or Web binaries. Dependency stack traces retain JavaScript locations but omit source-map translation. Dependency or embedding-backend changes must update the selection rule and pass the installed embedding and full-runtime checks. Publication fails before external writes when a prepared archive exceeds the budget; it does not silently discard additional files.
