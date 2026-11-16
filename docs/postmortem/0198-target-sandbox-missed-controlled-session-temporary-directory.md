# Target sandbox missed its controlled Session temporary directory

## Executive summary

Remote native commands carried their approved Session temporary path to the actual Executor, but target preparation did not create that child directory. Linux sandbox binding failed before the command could run. The target must prepare its approved filesystem inputs through the original operation and native directory owner.

## Summary

Three observed cold-recovery and external-token cases ended their actual command before the expected live barrier. A protected-create monitoring warning preceded the fatal `bwrap` missing-source error. These observations identify those cases; they do not establish that every failing Runtime scenario had this cause.

## Timeline

The original target preparation returned a prepared receipt while its Session directory was absent. A second actual Native Run/Use fixture accepted a symbolic parent. Both regressions failed before the correction. The corrected preparation and anchored directory suites pass on macOS, including a carried controller PID different from the target process. Actual Linux helper execution remains a separate acceptance gate.

## Root cause

The controller creates the Session directory only for a local Executor. That restriction correctly prevents source-side writes into a remote filesystem. The Linux helper prepares the shared temporary base, while the target preparation previously prepared only its wrapper. No original target owner materialized the approved Session child before sandbox binding.

## Guardrails

Workspace-write preparation creates only the original approved controlled child through descriptor-relative, no-follow directory creation. It retains the preparing receipt, original operation guards and Workspace identity checks. It preserves the carried controller path, does not create arbitrary writable roots, and only verifies directories on prepared retries. Read-only policy still grants no Session writable roots. The original Windows backend is unchanged.

- [x] Machine check: `packages/local-runtime/test/environment/preparation.test.ts` verifies actual Native Run/Use preparation, the carried PID, replay, absence of unrelated directory creation, no execution and symbolic-parent rejection.
- [x] Machine check: `packages/local-runtime/test/file/atomic-write.test.ts` verifies relative-input capture, empty directory creation, pending work, escaped/copy callbacks, symbolic links and directory replacement with both JIT modes.
- [x] Machine check: `packages/local-runtime/test/process/native-bindings.test.ts` preserves native file, process and PTY behavior in both JIT modes.
- [ ] Machine check: original cold native recovery and external-token cases must pass through the actual Linux helper before their Runtime scenarios are accepted.

## Lessons

Carry a filesystem selection across machines without performing its effects on the controller. Prepare only the approved original path at the actual Executor and distinguish preparation metadata from a process that genuinely started.
