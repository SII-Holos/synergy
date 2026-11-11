# Decision Record: Read private Sessions through bounded native contracts

Status: implemented

## Problem

Private member history must remain Runtime-owned while creator clients read it. Passing native Session objects through a generic proxy would expose local paths and unrelated metadata, and a separate Desktop history implementation would diverge from remote reads.

## Decision

Use one strict query and result contract for the native listener and transient organization exchange. The Runtime dispatcher resolves Scope from canonical Session identity, verifies the creator and driver binding, and walks canonical Cortex ancestry for child sources. It checks the captured binding again after reading and echoes that exact binding. A shared pure binding schema avoids dependency cycles and competing definitions.

The organization service authorizes the creator before dispatch and after the response. Its finite, separately signed permit binds the full query, subject, deployment, signing identity, Runtime connection and binding epochs. Reads share the existing transport lifecycle but have separate bounded capacity. They create no command receipt, shared projection or private-body persistence. The native listener uses its captured private bearer; caller-provided paths and arbitrary URLs are absent from the query.

Desktop exposes `memberRequest` with that same strict query. Main captures its supervised member identity, reads current organization directory and member registration before dispatch, and repeats authorization after the native reply. The creator must still own an active member Runtime and the directory must still name that driver and binding. Reading does not require execution permission. Main compares the native binding echo, bounds JSON responses and projects only fixed missing, revision-conflict and binding-change outcomes; native error metadata and listener credentials never reach the renderer.

Project native timeline and part metadata through explicit safe fields. Reuse canonical history windows and bodyless headers, preserving actual model, token and timing observations. Large fields use exact native version, field, byte count, checksum and original-content provenance. Retained partial output remains partial even after its available bytes are fully read. Native preparation returns explicit progress before its complete immutable descriptor is ready, keeping long materialization outside finite RPC duration.

`Read.matches` validates response identity, binding, version and byte windows. One stateless stream consumer awaits the append/hash ports, honors cancellation, preserves pending offsets and verifies the final digest before publication. It neither chooses transports nor buffers an entire file. Replay observations and current native Run identity are presentation; command admission remains authoritative.

## Alternatives considered

**Persist private bodies in the organization service.** This would violate member storage ownership and create a second body authority.

**Return full native objects or hydrate then slice JSON.** This would expose unrelated data and make memory depend on complete historical fields.

**Use creator-only reads for shared approvals.** Shared collaborators need a separate authorized interaction projection and native reply operation; private body access must not expand to supply it.

## Consequences

Generated native and organization clients exercise the same dispatcher over real HTTP and WSS, with exact binding and byte checks. Separate tests cover creator/lineage denial, current authorization after reply, partial provenance, stream integrity and bounded preparation. Main IPC regressions hold replies across a directory binding change and verify that read-only creators retain access while other creators and arbitrary native diagnostics remain excluded. The bridge and safe projection do not by themselves establish the complete private conversation route, native attachment downloading or handoff evidence closure.
