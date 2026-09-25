# Linux watcher build

Source: [`@parcel/watcher` 2.5.6](https://github.com/parcel-bundler/watcher/tree/v2.5.6), MIT.
[`poll(2)`](https://man7.org/linux/man-pages/man2/poll.2.html) reports `EINTR` when interrupted by a signal. The upstream backend treats it as fatal; `eintr.patch` retries that call without changing watcher selection or event handling. See [upstream signal report](https://github.com/parcel-bundler/watcher/issues/141).

`build-watcher.ts` verifies the pinned source, applies the reviewed patch, compiles the actual N-API binding and loads it to verify its patch marker. Benchmark preparation and release staging use this builder. Linux source development runs it during `bun dev prepare`; a cross-target invocation uses the pinned Node build image. Build output and its provenance receipt are local artifacts, never checked in.

Both glibc and musl bindings dynamically link the target system's `libstdc++.so.6` and `libgcc_s.so.1`, matching the upstream packages. Keep those runtime libraries installed. Static C++ runtimes can collide with other native modules in Bun; see the [linking decision](../../../../docs/decisions/implemented/bug-fix/2026-09-12-linux-watcher-shared-cpp-runtime.md).

On glibc Linux, run `bun test --config /dev/null test/script/watcher-native.test.ts` from the repository root after building. The suite uses fresh Bun processes, real Parcel recursive ignores, ONNX loading in both orders, event delivery, and an interrupted inotify poll. CI runs it on x64 and arm64 before uploading watcher assets. ONNX Node does not supply a musl binding; the musl build verifies its patch marker in the pinned Alpine image.
