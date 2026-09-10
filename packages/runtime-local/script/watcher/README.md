# Linux watcher build

Source: [`@parcel/watcher` 2.5.6](https://github.com/parcel-bundler/watcher/tree/v2.5.6), MIT.
[`poll(2)`](https://man7.org/linux/man-pages/man2/poll.2.html) reports `EINTR` when interrupted by a signal. The upstream backend treats it as fatal; `eintr.patch` retries that call without changing watcher selection or event handling. See [upstream signal report](https://github.com/parcel-bundler/watcher/issues/141).

`build-watcher.ts` verifies the pinned source, applies the reviewed patch, compiles the actual N-API binding and loads it to verify its patch marker. Benchmark preparation and release staging use this builder. Linux source development runs it during `bun dev prepare`; a cross-target invocation uses the pinned Node build image. Build output and its provenance receipt are local artifacts, never checked in.
