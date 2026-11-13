# Portable index rebuilding used the ambient writer

## Executive summary

Portable Home imports failed while rebuilding Cortex indexes because the importer owned a raw target Store transaction, while the index called an ambient Session business writer. The target Store must certify its own live transaction, and derived index owners must use that transaction throughout rebuilding.

## Summary

The full CI matrix exposed the same Cortex writer refusal in Home merge and relocation cases. Existing ordinary Session tests used `Storage.transaction`, so they did not exercise the portable import callback. Replacing the first guard with the current Store check alone was insufficient: a prepared target can differ from the current Store, and child index updates also consulted the ambient transfer guard.

## Timeline

- Home import cases failed at the Cortex native writer check.
- A real portable import reproduced the refusal; a separate real foreign transaction was incorrectly accepted by the index rebuild entry point.
- The importer and index owners were changed to retain the actual target Store and its original transaction. Ordinary business writers kept their guards.

## Root cause

Derived-index reconstruction reused business mutation entry points whose ambient ownership assumptions did not hold during native portable import. A transaction parameter was already available, but not every index owner consumed it.

## Guardrails

- `test/session/storage-indexes-portable.test.ts` checks imported visible and hidden Cortex children, rollback and mismatched Store rejection through real Stores.
- Existing Session index tests preserve retired endpoint and nullable metadata semantics.
- Home transfer tests exercise prepared target Stores independently of the current Runtime Store.
- [The decision](../decisions/implemented/bug-fix/2026-11-14-rebuild-session-indexes-with-the-original-import-writer.md) defines the native rebuild entry points.

## Lessons

Trace the actual transaction owner through every derived writer. A correct guard remains necessary when a caller needs a different, explicitly certified maintenance operation.
