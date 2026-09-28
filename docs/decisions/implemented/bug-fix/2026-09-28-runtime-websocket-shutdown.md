# Decision Record: Runtime shutdown after terminal WebSocket completion

Status: implemented

## Problem

A completed terminal can close its WebSocket and save its files while the enclosing Runtime never finishes closing. The pinned Bun server retains a closed WebSocket and its stop promise does not resolve, preventing controller recovery and clean process exit.

## Decision

Source development, CI, release builds, published runtime package requirements and the Execution Host image use Bun 1.4.2. The full-product regression opens a real terminal, receives its complete output, observes the server closing the socket, awaits Runtime closure and requires the child process to exit. A bounded observer kills only its own failed child and treats that deadline as a failure.

The regression reproduces the failure on Bun 1.3.14 and passes on Bun 1.4.2. The upstream [server-side close issue](https://github.com/oven-sh/bun/issues/36223) describes the same minimal server defect. The selected [stable release](https://bun.sh/blog/bun-v1.4.2) also includes the fix for the earlier 1.4.1 AsyncLocalStorage regression. The runtime package packer records the provenance beside the minimum version. Windows Job handles retain Bun's pointer-or-bigint representation, including handles read from native output buffers, without narrowing them through JavaScript numbers.

Local acceptance freezes the actual executing binary along with source and dependencies. Starting a run under another binary fails before driver side effects. Reports can still audit older frozen experiments without rerunning them.

Bun 1.4's [engine FFI](https://github.com/oven-sh/bun/issues/28792) requires JIT for `dlopen`. Explicit JITless execution binds the same native libraries through Bun's bundled C compiler and typed forwarding functions, without enabling JavaScript JIT or adding a system compiler prerequisite. The bridge resolves every requested symbol before returning and preserves the platform ABI and native error results. Normal execution continues to use `dlopen`. Actual file publication, owned process completion and PTY bytes run in both modes; Linux errno probes also cross the forwarding boundary.

Native startup can fail before a process is bound to its retained claim. Cleanup releases that unactivated claim rather than demanding a nonexistent process-tree completion receipt, preserving the original failure and allowing subsequent work. A missing-library subprocess verifies the failed receipt, absent side effect and empty claim ledger. Intentional whole-tree cancellation accepts the connection reset produced by the terminated worker, while still requiring native tree and stream drainage.

Closing a worker output socket also ends its destination stream, including Windows cancellation resets that do not emit a readable `end`. Already received bytes remain readable; forced destruction is reserved for the bounded unread-output shutdown path. The Executor regression requires a cancelled receipt, both complete output streams, retained save ownership and explicit release. Windows JITless bindings explicitly link the system loader through `kernel32`; the PTY binding probe requires one complete payload among ConPTY control bytes, while the owned-stream regression compares full binary output. Probe stages survive a child exit without diagnostic output.

The generated SDK observes rejection of `reader.cancel()` during SSE abort. The pinned OpenAPI generator carries the patch so regeneration retains this behavior; a real HTTP stream and the CLI cancellation suite verify clean process exit. The patch is removable when the upstream generator observes that promise itself. Empty explicit Bun configuration still discovers the working-directory test preload, so guard subprocesses start in their independent fixture directory to exercise the requested environment unchanged.

## Alternatives considered

**Bound or ignore the server stop promise.** This hides an undrained transport and falsely reports successful Runtime closure. The independent process-exit oracle must remain authoritative.

**Use a special terminal close sequence.** Closing through the client works around one trigger but does not cover other ordinary server-initiated closes. The minimal Bun reproduction fails without Synergy, so the fix belongs in the runtime dependency.

## Consequences

Consumers of published runtime packages need Bun 1.4.2 or later. The repository validates one consistent pinned version across local source, CI and distribution builds. The shutdown test requires the native PTY helper and uses no model provider. Runtime dependency changes require fresh frozen acceptance inputs rather than borrowing results from the earlier binary.
