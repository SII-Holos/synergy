# Task retry replaced the original release identity

## Executive summary

Native intake preserved the first accepted task receipt while overwriting its resource-release entry from a newly received retry permit. The retry could replace the grant, admission, attempt and actor, or reopen an already settled entry. The release writer must follow the immutable logical acceptance rather than the current attempt.

## Summary

This surfaced while validating the organization command portability owner. That owner correctly compared release history against the first accepted native root. Native task retries could violate that comparison before any transfer. Existing retry coverage used context input without a provisional resource grant, so it established one Inbox effect but did not exercise the release family. The issue was found in isolated fixtures; production handoff completion was not involved.

## Timeline

1. Portability validation rejected altered release binding and original accepted-permit identity in rehashed packages.
2. Review of real retry semantics found the accepted receipt remained the original value, but `persist()` wrote release fields from the newest permit whenever that receipt was returned.
3. A real signed task retry changed the provisional grant, attempt, admission and display name. The assertion retaining the original release failed with those replacement values.
4. Intake restricted release creation to the first logical acceptance and constructed it from that accepted permit.
5. The regression passed through another attempt after settlement without reopening the release; a new logical task still produced its own release and Inbox item. The real portable source/target fixture also retained an accepted task retry with an unused new grant.

## Root cause

The receiver separates attempts from logical accepted effects, but the release writer used the attempt's permit in a shared persistence path. Reusing a prior accepted result was therefore mistaken for creating new resource ownership. Resetting the entry to pending also discarded its settlement evidence.

The context-input retry fixture had no grant or release entry, leaving the incorrect task-specific write unobserved.

## Guardrails

Only a newly accepted logical task writes its release entry, using the original accepted permit and actor. Replays preserve the entire existing entry, including released state. A new task request retains independent ownership. Portability continues rejecting inconsistent identities rather than weakening its target checks. Historical inconsistent rows are not silently rewritten by a handler.

`test/command-intake.test.ts` exercises signed retries with changed attempt/grant/name, settlement followed by another retry and a genuinely new task. `test/session-transfer.test.ts` carries the resulting original release through real native source preparation and target adoption. See [organization command closure](../decisions/implemented/architecture/2026-11-12-carry-exact-organization-command-closure-through-paused-transfer.md).

## Lessons

Task reception and resource ownership need joint retry coverage. A preserved Inbox effect alone cannot establish immutable grant attribution or completed release lifecycle.
