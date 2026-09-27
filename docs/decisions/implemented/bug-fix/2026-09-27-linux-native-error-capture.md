# Decision Record: Capture Linux process errors before returning through FFI

Status: implemented

## Problem

Linux process supervision must distinguish a live child from a completed child set and a failed kernel operation. Reading thread-local errno in a separate JavaScript FFI call does not preserve the error associated with the original call: intervening runtime work may change it. The same gap affects subreaper initialization, child reaping, opening a pidfd and sending a signal. An incorrect error can prevent a completed tool from releasing its Workspace claim; treating an unknown error as completion would release ownership without evidence.

## Decision

The existing packaged Rust native library performs each Linux operation and captures errno before returning to JavaScript. Its Linux exports return nonnegative results on success and negative errno on failure. Successful PID and descriptor results fit the signed 32-bit interface; conversion rejects overflow with `EOVERFLOW`. Variadic arguments use explicit machine-word widths. The existing PTY ABI remains version 2 because its symbols and representations are unchanged.

LinuxTree loads these operations through the same native library locator used by PTY in source and installed runtimes. Missing libraries or symbols fail before command activation, with preparation or reinstall guidance. The normal native build and asset paths carry the library; command execution does not compile native code.

Native library loading and the builder share the Util package's `nativeLibc()` selector. On Linux, the compiled target override takes precedence; source execution detects musl from the mapped dynamic loader. Non-Linux hosts default to glibc for cross-build selection. An explicit builder target libc takes precedence over the detected default. This keeps preparation and execution on the same ABI without adding a product option.

The completion rule is unchanged: `waitpid` returning zero retains ownership, reaped children are drained, `EINTR` may retry within the existing bound, and only `ECHILD` proves completion. Other errors remain failures. Pidfd identity checks and the handling of an already-exited signal target remain intact.

## Alternatives considered

**Cache the errno address or combine JavaScript reads.** Thread-local storage identifies the location, not the originating call. Runtime work can still overwrite it before JavaScript reads it.

**Ignore or retry an unexpected error.** This would conceal the lost association and could change the evidence required to release a process claim. The implementation retains the existing error policy.

**Compile a new helper during execution.** This adds deployment prerequisites and another native asset owner. The existing Rust library already supports the required platforms and packaging paths.

## Consequences

Ordinary Linux process supervision depends on the prepared native library, as PTY already does. Its source hash includes the Rust source and dependency manifests, so cached assets must match these exports. Installed and frozen-source distributions must prepare and carry the same library.

Shared CI preparation builds and transfers the library with its complete byte inventory; cache identity includes the Rust source, build recipe and actual compiler identities. Frozen benchmark sources exclude generated artifacts, so their preparation builds this library in a separate pinned Rust stage and copies only runtime outputs into the final bundle. The measured source determines whether that builder exists within its supported package layout: rollout sources without it retain watcher-only preparation, and session-export sources retain their original recipe. The renamed evaluator uses current composition exports; historical package layouts retain their frozen evaluators. No current checkout artifact or compiler is injected into a measured runtime. A cold prepared-bundle control runs the existing ownership and byte-integrity test in a compiler-free, network-disabled container.

Regression fixtures use real kernel calls in isolated Linux subprocesses. A real nonblocking read changes errno after the FFI call returns; empty and held child sets preserve their distinct completion states with JIT enabled and disabled. Invalid pidfd calls retain their own errors, and an incompatible library cannot activate a command. These tests prove the unsafe association and its repair; they do not establish the precise intervening operation in an intermittent CI failure. The existing ownership, stream and lost-supervisor tests continue to govern process cleanup.
