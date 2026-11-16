# Organization view recovery retained old requests

## Executive summary

Closing a resource editor left its save callback attached to the Space lifetime. An old successful response could close a replacement form. The same broad lifetime let organization catalogs retain private state after access denial. Component disposal and captured view generations now retire those UI effects while temporary transport failures preserve drafts.

## Summary

Headless App fixtures reproduced the issues using isolated browser storage and controlled native-bridge responses. No user desktop, copied Home, operating-system dialog or active Runtime was used. The backend-side save was treated as accepted before its response was held; the fix prevents stale UI completion without claiming that the mutation was undone.

## Timeline

1. At 375 and 1100 pixels, the fixture held a resource save, cancelled its editor, opened another draft and released the first response. Both cases removed the new form.
2. Knowledge, resources, members and artifacts loaded private metadata, then received a real 403 API response during paging. All four retained their previous private content. A pending invitation fixture also reached that retention failure.
3. Four 503 cases passed before the fix, establishing that temporary failure already retained drafts and one-time links.
4. Local editor disposal and catalog request generations fixed the seven observed failures. The completed invitation fixture then verified that an older response cannot replace a newer recovered link.
5. Additional browser checks verified nested file-metadata and resource-access denial, plus first, explicit-null and cloud infrastructure selection preservation. That fixture passed 17 cases with 69 assertions.
6. Review found that resource/member confirmations belonged to the surviving catalog rather than its cleared subtree. Two more real App cases reproduced dialogs remaining after 403, while 503 correctly retained them.
7. Exact owned-dialog retirement and show-time generation/target snapshots closed those cases. The final App fixture passed 21 cases with 89 assertions; three focused confirmation cases passed 20 assertions, including reuse, another owner and late pending success/failure.
8. A separate App fixture reproduced inline project saves closing replacement edits, member discovery admitting an older search, reactive project props reviving the old member view, nested member denial retaining its parent project, confirmations borrowing a refreshed revision, and resource-access reads and writes surviving an account → project → account cycle. All twelve cases initially failed, including four publication cases with duplicate actions or explanations.
9. Captured component and selector generations fixed those request cases. The first rerun passed ten cases and exposed the artifact empty state repeating its existing explanation after Cancel. Removing that duplicate retained the page-level guidance and synchronous focus behavior.
10. The final request/publication fixture passed twelve cases with 51 assertions. The eight existing project/catalog cases passed 46 assertions; three targeted conversation cases passed 103 assertions across narrow and wide layouts, read-only access and root-versus-child task controls. Screenshots verified the publication states and conversation geometry; this did not establish long-history body acceptance.
11. Two further App cases held an accepted project save across a successful refresh that removed management permission but retained read access. Both retained the old editor. Retiring its generation preserved the current readable project and rejected the late old save result; the expanded request fixture passed fourteen cases with 65 assertions.

## Root cause

Account selection and view lifetime were conflated. A Space can remain selected while a form closes or its current project access changes. The shared signal therefore stayed live, and error handlers displayed a message without removing dependent state. Retrying could produce a new authorized observation while old asynchronous responses remained eligible to write.

## Guardrails

- [x] Machine check: `apps/web/test/organization/workspace-recovery.browser.test.ts` — accepted save, Cancel, replacement draft and old response at two viewport sizes.
- [x] Machine check: the same fixture covers all four catalogs under 403 and 503, one-time invitation ordering and nested metadata/access failure.
- [x] Machine check: the same fixture verifies exact model-edit requests for first, null and cloud infrastructure selections, plus held catalog responses with old confirmation events and fresh revision-checked confirmation.
- [x] Machine check: `apps/web/test/components/dialog/confirm-owned.browser.test.ts` — exact owned-dialog closure preserves another owner and suppresses late retired completion and failure feedback.
- [x] Machine check: `apps/web/test/organization/workspace-requests.browser.test.ts` — project editor replacement, member discovery and reactive owner changes, actual project denial, fixed confirmation revisions and resource selector cycles across held reads and accepted writes.
- [x] Machine check: the same fixture checks one publication entry and explanation, explicit opening/cancellation focus and narrow geometry for knowledge and artifacts.
- [x] Machine check: the same fixture holds an accepted save across management downgrade at narrow and wide sizes, preserving the earlier 503 draft before the confirmed permission change.

The [decision](../decisions/implemented/bug-fix/2026-11-12-retire-organization-view-requests-before-recovery.md) defines disposal and restoration behavior. The frontend Skill requires testing a held accepted mutation across form replacement and access recovery.

## Lessons

A selected account is insufficient evidence that a particular editor or result is still current. Retire local callbacks separately from backend execution, and use current authorization failures to remove private state without treating every network failure as permission loss.
