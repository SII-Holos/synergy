# Watcher static C++ runtime crashed subsequent ONNX loading

## Executive summary

The Linux Parcel EINTR build introduced a second C++ runtime into Bun. A watcher subscription with recursive ignore expressions initialized locale state, and loading ONNX afterwards crashed the process. Node-only build checks and watcher tests without ignore expressions missed the interaction. Linux bindings now share the system C++ runtime, with real Bun coexistence and signal-recovery tests before artifact publication.

## Summary

A user reported that sending a message crashed the server while loading the ONNX Node 1.24.3 binding, affecting new and existing sessions. Rolling back before commit `3184b42b50` restored operation. That commit patched Parcel's inotify handling, not Bun, and added a native builder using `-static-libstdc++ -static-libgcc`.

## Timeline

- 2026-09-10: The patched watcher builder shipped with a Node patch-marker check and an interrupted-poll fixture.
- 2026-09-12: Investigation reproduced the crash using the published watcher assets, Bun 1.3.14 and ONNX Node 1.24.3 on glibc x64 and native arm64.
- 2026-09-12: A regression test failed when ONNX followed a subscription with recursive ignores, while the reverse order and EINTR recovery passed. Removing the static-runtime flags repaired the failing sequence.

## Root cause

Parcel's wrapper compiles ignore globs to expressions consumed by native `std::regex`. This initializes C++ locale state. The statically linked watcher exported GNU-unique locale facet identifiers. During subsequent ONNX loading, dynamic-linker tracing showed the system libstdc++ binding locale identifiers to the watcher, mixing the two runtimes' state. [GCC documents](https://gcc.gnu.org/onlinedocs/gcc/Code-Gen-Options.html#index-fno-gnu-unique) that GNU-unique definitions remain unique even across `RTLD_LOCAL` modules. A minimal native module using only a C++ regular expression reproduced the same static-versus-dynamic difference without watcher threads or inotify.

Node already loaded the system C++ runtime before requiring the watcher, masking this order dependence. Bun did not. Initial investigation probes also used empty ignore arrays, so they never exercised the relevant locale initialization. A native module that loads successfully alone is insufficient evidence of safe coexistence.

The first message runs Library recall, whose default local embedding path lazily imports Transformers and ONNX. That follows project watcher setup, explaining the reported trigger across session ages. The available user log identifies the active native load, not the exact faulting C++ instruction; the reproduction establishes the regression without claiming an identical fault address.

## Guardrails added

- The [builder](../../packages/runtime-local/script/build-watcher.ts) shares the system C++ runtime; the [decision](../decisions/implemented/bug-fix/2026-09-12-linux-watcher-shared-cpp-runtime.md) records alternatives and target requirements.
- The [native suite](../../test/script/watcher-native.test.ts) requires real recursive ignores, both ONNX load orders, post-load events and interrupted-poll recovery under Bun.
- [Helper CI](../../.github/workflows/build-helpers.yml) validates glibc x64 and arm64 before uploading bindings; [general CI](../../.github/workflows/ci.yml) also exercises the suite.
- The [development Skill](../../.synergy/skill/develop-synergy/SKILL.md) routes watcher changes through the compiled regression suite.

## Lessons

Preserve the upstream runtime-linking arrangement unless a reviewed requirement justifies changing it. Native smoke tests must match the host runtime and the product inputs that initialize native state. Test interacting native modules in fresh processes and both load orders; JavaScript exception handling cannot recover a process segmentation fault.
