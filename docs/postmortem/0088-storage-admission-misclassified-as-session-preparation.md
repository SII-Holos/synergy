# Storage admission misclassified as Session preparation

## Executive summary

Ordinary Sessions could fail with a historical preparation error under storage pressure. The timeout covered the locator read before it established whether import was needed. A new input could then select an earlier failed reply, making a recoverable execution failure appear permanent.

## Summary

The visible symptoms were slow historical navigation, preparation failures during active execution, and another terminal error after sending a new message. Read-only inspection found no pending import locators for the affected Sessions. An isolated consistent data copy and temporary-store regressions separated queue delay from actual historical import.

## Timeline

- 2026-10-22: delayed storage admission reproduced a preparation error for both a Session without a locator and an already-imported Session.
- 2026-10-22: pause reads and cross-root result selection exposed independent failure amplification paths; focused regressions reproduced them before correction.
- 2026-10-22: isolated historical input completed through the ordinary durable input API after the fixes.

## Root cause

The preparation timer started before the locator read settled. A busy reader therefore consumed the import budget even when no import existed. Catch-all pause reads erased storage errors, and the result selector's final fallback accepted an unrelated historical assistant. These mechanisms were independent of the number of pending historical imports.

## Guardrails

The [Session state decision](../decisions/implemented/bug-fix/2026-10-22-preserve-session-state-under-storage-pressure.md) defines the corrected ownership. Tests use real temporary storage admission, preserve pause state on read failure, require new replies to belong to the admitted root, and verify retry after cancelled presentation replay. Real-data copies and logs stay outside CI and public artifacts.

## Lessons

A timeout describes elapsed waiting; domain state requires durable evidence. Failure of one execution does not terminate the Session's ability to accept a new task. Reduced write pressure and bounded fixture memory do not establish the retaining path of a separate long-running process's memory growth.
