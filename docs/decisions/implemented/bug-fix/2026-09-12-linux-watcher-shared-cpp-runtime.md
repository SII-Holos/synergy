# Decision Record: Share the system C++ runtime in Linux watcher bindings

Status: implemented

## Problem

The patched Parcel watcher statically linked libstdc++ and libgcc. Initializing its recursive ignore expressions before loading ONNX Runtime could crash the Bun process because GNU-unique locale symbols connected two C++ runtime implementations. The [postmortem](../../../postmortem/0011-watcher-static-cpp-runtime-crash.md) records the reproduction and missed coverage.

## Decision

The [watcher builder](../../../../packages/runtime-local/script/build-watcher.ts) uses dynamic C++ runtime linkage for glibc and musl, matching Parcel's published Linux packages. The pinned source, EINTR patch and patch marker stay unchanged. The build receipt hashes the builder, so this change invalidates cached static artifacts without changing the source-patch identity.

The [native regression suite](../../../../test/script/watcher-native.test.ts) loads the actual built watcher and installed ONNX Node module in separate fresh Bun processes for each load order. A subscription with real recursive ignore rules must coexist with ONNX and deliver an event. A separate real signal interruption must preserve event delivery. General CI runs the suite on glibc x64; helper CI also runs it on glibc arm64 before uploading assets.

## Alternatives considered

**Remove the EINTR patch.** Rejected because signal interruption still needs recovery. The C++ source patch was not responsible for the runtime collision.

**Hide a statically linked C++ runtime.** Rejected in favor of upstream's simpler shared-runtime arrangement. Correct isolation would require auditing exported templates, locale state and exception symbols for every toolchain.

**Load ONNX first or disable local embedding.** Rejected because this relies on incidental initialization order or removes working product behavior. Other native modules can encounter the same duplicate-runtime problem.

## Consequences

Linux installations must provide the target system's libstdc++ and libgcc shared libraries, as required by the upstream watcher packages. The pinned Debian and Alpine toolchains preserve the target ABI baseline. The marker proves the EINTR patch only; replacing or rebuilding an affected watcher asset is still required even if its marker matches. The ONNX coexistence test applies to glibc because ONNX Node supplies no musl native binding; musl retains the build-time load check in Alpine.
