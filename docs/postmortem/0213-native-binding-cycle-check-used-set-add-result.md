# Native binding cycle check used the Set.add result

## Executive summary

A native binding reader intended to stop repeated Cortex ancestors but tested the return value of `Set.add()`. That value is the Set itself, so a persisted parent cycle repeated canonical reads instead of terminating. Check membership before insertion.

## Summary

A review of ordinary binding reads found the ineffective visited check. A controlled historical-corruption fixture installed two locally valid canonical pairs with matching Cortex parents, then exercised the ordinary binding readers. The original operation reached a fourth pair read and was stopped by a test-local read budget. This was a controlled reproduction, not an observed user-data incident or a public Session-creation bypass.

## Timeline

- Source tracing found the truthy Set result in the ancestry loop.
- The fixture verified each native index/Info pair and dynamic Session schema before calling the original readers.
- The original reader failed the finite read-budget control; no timeout or abandoned asynchronous read was required.
- Explicit membership testing passed both binding modes, retained their ownership checks and resolved restored acyclic data normally.

## Root cause

Per-record parent consistency does not establish a globally acyclic ancestry. The reader's intended duplicate guard never inspected membership. Public Session APIs constrain parent creation and identity changes; imported historical metadata still needs safe read traversal. This fix adds no claim about arbitrary privileged bulk graph writes.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/sync-native-binding-work.test.ts` — real migration fixture, two ordinary reader modes, three canonical pair reads, finite original-loop failure and restored valid roots.
- The [cycle decision](../decisions/implemented/bug-fix/2026-11-15-reject-cyclic-native-binding-ancestry.md) records the exact membership rule and unchanged authority checks.

## Lessons

Verify collection API return values when implementing graph guards. Test a globally invalid graph whose individual records remain valid, and force an incorrect traversal to settle before restoring its observer.
