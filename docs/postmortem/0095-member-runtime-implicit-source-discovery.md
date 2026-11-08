# Member Runtime implicit source discovery

## Executive summary

Member Runtime integration tests exposed discovery outside declared process and project inputs. Explicit environment objects did not prevent Bun from loading dotenv and preload files, and physical path containment did not guarantee that a lexical ancestor walk would stop at a symlinked root. The failures were reproduced with disposable fixtures, before enabling organization execution.

## Summary

Agent and policy workers inherited the launch directory. Their source command allowed Bun's automatic configuration loading. Separately, instruction discovery checked physical containment but compared raw paths while walking upward. On macOS, `/var` and `/private/var` could refer to the same project while never comparing equal at the stop condition. Ancestor instruction text then entered the project result.

## Timeline

1. Real subprocess tests placed artificial private values in dotenv and preload files. Both worker roles observed those values despite an explicit parent environment.
2. Member Runtime source tests found ancestor instructions when Scope and Workspace used different names for the same physical directory.
3. Focused generic regressions reproduced both failures. Worker startup also accepted an owned Home when its pinned component selection omitted the Home owner.
4. Source commands disabled automatic loader inputs, worker directories were made explicit, Home ownership was checked before readiness, and instruction traversal used physical paths consistently.

## Root cause

Isolation was checked at the parent data structure rather than through the child loader, and path containment used a different identity than traversal termination. Foreground Home admission did not cover direct worker entrypoints.

## Guardrails

Harness `test/session/worker-environment.test.ts` starts actual child processes with conflicting loader files. `test/session/instruction-source.test.ts` verifies both personal and exclusive discovery through a directory alias. Agent Runtime `test/workers.test.ts` rejects absent Home owners; organization-runtime `test/runtime.test.ts` verifies matching workers, mismatched markers and separate personal/A/B sources. The [composition decision](../decisions/implemented/architecture/2026-11-08-member-runtime-composition.md) records the resulting startup choices.

## Lessons

Observe the consumer after runtime initialization, not just its prepared inputs. Use the same physical identity for containment and stopping conditions, and verify every executable entrypoint that can access an owned Home.
