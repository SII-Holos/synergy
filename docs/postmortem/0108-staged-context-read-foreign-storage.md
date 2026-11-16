# Staged contexts read foreign Storage

## Executive summary

A prepared native handoff context checked its Runtime but not its Store or artifact configuration. An isolated reproduction used the same handoff and Session IDs in two Stores and returned the foreign namespace's private record. The fix binds the original native owner and snapshots selectors before asynchronous work.

## Summary

The failure was reproduced in temporary Runtime fixtures. No active user Runtime, Home or model data was touched. Separate controlled cases also changed handoff selectors and the cancellation signal while the real staging state read was pending.

## Timeline

1. A context successfully read its original staged record.
2. The caller entered another Store in the same Runtime and staged different private bytes under the same selectors. The original context returned those bytes instead of rejecting the call.
3. A state-read barrier reproduced request replacement and bypass of an original abort.
4. Review reproduced an additional stream error: after the first yielded chunk, the loop advanced the real native reader once before rejecting escaped ownership. A separate 129-record fixture also issued its second native metadata query after escaping at the first page boundary. Explicit checks before each advance prevented both extra reads.
5. Context entry snapshots, strict Storage ownership checks and deferred stream checks made the original failures reject while native staging and dependency tests retained their behavior.

## Root cause

The context kept the Runtime identity but its methods called ambient Storage readers. Its initial awaited read preceded capture of the caller's mutable object. Readonly TypeScript fields did not freeze nested Session metadata or mapping, and an iterator factory was not the last point where a consumer could change native contexts.

## Guardrails

`test/session/transfer-context-ownership.test.ts` exercises actual independent Stores, an asynchronous state-read barrier, original cancellation, changed artifact settings and artifact iteration before and after its first chunk. Existing staging/dependency/Core tests retain canonical unknown data and transactional publication. The [decision](../decisions/implemented/bug-fix/2026-11-12-bind-staged-owner-contexts-to-original-storage.md) defines the native ownership checks.

## Lessons

A Runtime can host several Storage scopes. Capture selectors and their actual data owner before awaiting, then qualify every returned record or chunk with that same owner. Reject escaped use instead of silently reentering a private namespace for the caller.
