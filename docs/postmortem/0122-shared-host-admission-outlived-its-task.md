# Shared Host admission outlived its Task

## Executive summary

Connecting shared process callers to explicit Host origins exposed a preparation window: an original Task could become paused while native resources were preparing, yet the new Host command would still execute. Caller-owned request objects could also change during those waits. The callers retain the original Task through preparation, validate it before accepting the Host process, and snapshot mutable request data at entry.

## Summary

Isolated temporary Homes exercised actual native formatter, language-server and PTY processes. No copied Home, user desktop or operating-system dialog participated. The initial origin enforcement correctly blocked callers that lacked provenance; adding their composition ports required preserving the original owner's admission through asynchronous preparation, rather than treating a Host token as a replacement for it.

## Timeline

1. New formatter, LSP and terminal execution fixtures failed because their resource calls supplied no origin. The existing origin-less resource-frame refusal remained a passing negative control.
2. Composition ports restored legitimate operations. Actual language-server and terminal processes continued echoing after their initiating native Task paused, while Session drainage excluded those independent Host operations.
3. Separate fixtures held the actual native provider's connection after the original Task's initial admission, paused its canonical Session, then released preparation. Both callers returned an accepted process and executed a command that wrote a marker: `admitted: true, executed: true` instead of two false values.
4. Revalidating the original captured Task after resource resolution refused those launches and left no marker or active execution. This refusal precedes acceptance of the shared Host process; it does not cancel an already accepted service when the initiating Task later pauses.
5. Held formatter and language-server preparation accepted later replacements of command arrays and environment values. A held terminal Session read also replaced the displayed Session association. Entry snapshots fixed those three native counterexamples.
6. Canonical execution receipts revealed that formatter and LSP callers could attach an ambient Scope Workspace when the selected resource frame had none. Preserving that frame's explicit selection removed the extra mount.

## Root cause

The callers combined distinct lifetimes. A selected Task justified entry, while a shared Host process needed an independent lifetime after acceptance. Checking only the first admission allowed a stale Task to cross the preparation wait. Re-reading caller objects or falling back from an empty selected Workspace similarly changed the operation after it had begun.

## Guardrails

- [x] Machine check: `packages/formatter/test/format/process-origin.test.ts` executes native commands, verifies inherited and component provenance, refuses origin-less frames, retains input snapshots and checks selected Workspace absence.
- [x] Machine check: `packages/lsp/test/lsp/process-origin.test.ts` holds native preparation across canonical Task pause, checks zero unauthorized effects, and verifies that an accepted shared server continues serving independently.
- [x] Machine check: `packages/local-runtime/test/process/pty-origin.test.ts` repeats the preparation refusal with an actual PTY, retains Session/command snapshots and proves native output after the initiating Task pauses.

The [ownership decision](../decisions/implemented/architecture/2026-11-12-keep-shared-processes-under-explicit-host-origins.md) defines acceptance and shared-service lifetime. Existing process, Environment and Workspace tests retain cancellation, binary output, whole-tree drainage and allocation-relocation checks.

## Lessons

A new Host operation needs its own explicit owner and a defined acceptance point. It cannot silently replace a Task that lost admission during preparation. Validate both sides of the asynchronous wait, then keep the accepted shared service's lifetime separate from the initiating Task. Bind selectors and mutable request data at entry rather than deriving a different operation after the wait.
