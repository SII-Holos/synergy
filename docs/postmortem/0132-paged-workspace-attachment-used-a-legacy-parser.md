# Paged Workspace attachment used a legacy parser

## Executive summary

Harness attachment rejected a valid paged saved head before reaching the native FileHost that already supported it. Attachment now reuses the canonical archive copier instead of requiring a legacy manifest.

## Summary

A real native Environment fixture created a saved tree spanning multiple metadata pages. Attachment failed at `WorkspaceContent.manifest`, which deliberately rejects paged trees. The native materializer was never reached. The corrected path copies the complete verified graph through the archive owner and passes its descriptor to the existing native request.

## Timeline

1. The fixture saved 260 binary files in a paged object-backed Workspace with an idle Environment.
2. Actual attachment failed at the legacy-only manifest reader.
3. The archive owner supplied a complete graph copy without another decoder.
4. Attachment succeeded; removing all original object files did not affect native reads.
5. Detachment saved through the original checkpoint owner, released retained Uses and made the saved bytes readable again.

## Root cause

Updating the lowest native consumer did not update its Harness caller. Its intermediate parser still constrained accepted saved-head formats.

## Guardrails

- [x] Machine check: `packages/local-runtime/test/workspace/mount-paged.test.ts` exercises actual attachment, native reads after object loss, checkpoint save and released Uses.
- [x] Machine check: `packages/harness/test/workspace/archive-paged.test.ts` verifies the original destination port, opaque saved selection, foreign Runtime refusal and full-file digest failure before descriptor publication.
- [x] Procedure: the persistence Skill traces intermediate consumers and reuses the canonical complete graph copier.

## Lessons

Verify the full production caller path after extending a consumer. A capable native materializer does not prove its caller accepts the same format. See [the decision](../decisions/implemented/bug-fix/2026-11-12-attach-paged-workspaces-through-verified-archive-copies.md).
