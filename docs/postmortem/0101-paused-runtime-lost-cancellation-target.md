# Paused Runtime lost its cancellation target

## Executive summary

A cold paused Session had no cancellation target in organization status despite retaining a native unfinished task. The projection relied on transient execution ownership. Status now resolves the native effective task root when that lease is absent.

## Summary

The Run and pause latch survived restart. The status adapter considered only a live lease, busy activity and queued Continue, so the frontend lacked the Run ID needed to cancel the task. No execution or stored input was lost.

## Timeline

- A real two-Runtime, one-Home regression retained an interrupted Run and reopened the paused Session.
- The native effective-root lookup returned the original task, while organization status returned no Run ID.
- A second regression reproduced the gap before a native Run had opened and retained a later non-root context message.
- Native-root selection and Run validation restored the cancellation target; native cancellation left terminal work without a target.

## Root cause

Transient lease ownership was used as the only ordinary task identity. The paused branch preserved the pause reason and timestamp but had no cold selection path. The native Continue path already owned the required effective-root semantics.

## Guardrails

The real Home restart and unopened-root tests live in `packages/organization-runtime/test/session-status.test.ts`. They verify no observation starts execution and that later context does not replace the root. Live lease and retry precedence remain covered. Existing signed command tests continue to validate control versions, binding fences, rollback and native receipts.

## Lessons

A projection needed after restart must reconstruct identity from its native owner. A duplicate durable pointer or newest-message heuristic would create another synchronization problem.
