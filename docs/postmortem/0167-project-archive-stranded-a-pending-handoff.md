# Project archive stranded a pending handoff

## Executive summary

The service allowed a project to archive while its Session retained an unresolved handoff. Subsequent human handoff coordination required project execution permission, which archive had removed.

## Summary

A real handoff preparation committed its directory lock. Project update then committed archive without checking that lock. The same defect reproduced with handoff SQL held before commit and archive queued behind it. Archive winning the reverse order already rejected new handoff preparation correctly.

## Timeline

1. Prepare a private Session handoff through two signed Runtime connections.
2. Observe archive succeed where pending handoff settlement should block it.
3. Reproduce the same result with the actual handoff transaction committing first.
4. Check canonical directory metadata in the original archive transaction.
5. Verify both commit orders, late-page private Sessions and native cancellation settlement.

## Root cause

Project update validated management authority and revision, then wrote lifecycle state without consulting the Session directory's unresolved handoff ownership. Existing archived-project execution checks were correct; widening them would hide the missing lifecycle check.

## Guardrails

- Session directory archive checks require the original write transaction and page canonical metadata rather than caller-visible projections.
- Service cancellation acknowledgement cannot release archive; the actual signed source proof must clear the directory lock.
- Tests hold the real SQL writer in both orders and preserve private Session denial, independent project archive and unchanged Session state on project restore.

## Lessons

Check unresolved domain ownership before withdrawing the permissions needed to settle it. Put that check in the same transaction as the lifecycle change.
