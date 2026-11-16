# Cortex files confused caller and ancestor roots

## Executive summary

The organization file-source adapter required the accepted resource root to equal its native tool origin. A legitimate Cortex child has its own root, Run and tool, while the verified organization grant belongs to an accepted ancestor. The equality guard rejected ordinary child file tools before their first remote operation.

## Summary

The registered Runtime fixture creates a child through Cortex, materializes its native Inbox task, records its Run and file tool, and resolves the real organization provider. Before the fix, View failed with `Organization files cannot replace their original native Task root`. Replacing the child origin with ancestor metadata would violate native provenance, so both owners must remain distinct.

## Timeline

Independent review identified the mismatched identities. The real child regression failed at the original guard. The member file-resolution owner now retains and rechecks the canonical accepted lineage alongside the original caller, and View/Edit/Save pass through the actual service transport.

## Root cause

The adapter compared two identities serving different purposes. Environment origin proves the child Session/root/Run/tool that performs I/O. The existing execution lineage proves which accepted ancestor actor/root supplies its organization resource grant. A direct Session can share those identities; a child cannot.

## Guardrails

The member owner checks the original child origin through canonical Environment admission, retains its parent/task/binding metadata, and reuses executionLineage before and after remote calls. The provider continues signing the original accepted ancestor proof and retains its connection and CAS reference. Cancellation rejects further calls from the old child lease. Cold reconciliation inspects only the same recorded ancestor authority without binding or replaying the write.

## Lessons

Exercise resource adapters through real delegated native callers. A direct Session fixture cannot establish correctness when caller provenance and accepted resource ownership legitimately belong to different Sessions.
