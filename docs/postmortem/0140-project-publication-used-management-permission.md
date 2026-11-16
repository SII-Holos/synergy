# Project publication used management permission

## Executive summary

Knowledge publication controls used project management permission instead of the service's project execution permission. Collaborators could apply versions but could not publish, while archived maintainers still saw write controls. The UI consumes the owning permission and preserves readable versions. Related direct-link and confirmation tests fixed empty denied pages and a revision change behind an open withdrawal.

## Summary

The PRD permits project collaborators to publish materials and Skills. The service implements that rule through project execution authorization, but the frontend reused its project-membership management flag. A prior browser assertion explicitly expected the collaborator's new-version action to be absent, preserving the wrong behavior.

## Timeline

1. Current PRD and service authorization were compared with the existing frontend gates. The incorrect management flag affected new publication, new versions and withdrawal.
2. The real App fixture changed the existing collaborator expectation and added narrow/wide collaborator, reader and archived states. Collaborator actions were missing and archived write actions were present. Direct organization Members/Resources and project-reader Members links also produced no access state.
3. Those controls were aligned with current execution permission, while readable versions and ordinary project navigation stayed available.
4. The first withdrawal fixture used an incorrect endpoint and timed out; its timeout and subsequent closed-browser failures were discarded as behavior evidence. The fixture was corrected to the generated client's actual DELETE operation.
5. A targeted real App run held a catalog reload behind an open confirmation. The original revision was one, but the actual DELETE sent revision two. Withdrawal was then changed to retain the identity and revision captured at show time.

## Root cause

The frontend treated a nearby management flag as the publication owner's policy. It also hid unavailable navigation without rendering the corresponding direct-link state. The withdrawal callback read reactive item metadata when confirming, so a late catalog response changed the user's approved target.

## Guardrails

- [x] Machine check: `apps/web/test/organization/workspace.browser.test.ts` exercises project publication permissions and archive state at 375 and 1100 pixels while retaining ordinary version application.
- [x] Machine check: the same fixture opens denied management routes directly and verifies readable navigation without private catalog requests.
- [x] Machine check: the same fixture holds catalog metadata behind withdrawal and checks the actual DELETE payload's original revision.
- [x] Owning procedure: the frontend Skill requires publication-owner permission checks and fixed confirmation revisions.

## Lessons

Permission names describe different user work. Use the effective permission of the operation being presented, and keep a confirmation tied to the object version the user reviewed. See [the publication control decision](../decisions/implemented/bug-fix/2026-11-12-align-knowledge-publication-with-project-execution.md).
