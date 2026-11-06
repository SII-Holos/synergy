# Workspace-free attachment preparation

## Executive summary

A managed Desktop session with no directory could fail immediately when sending an uploaded image, before any provider call. Workspace-owned file-read evidence was incorrectly applied to Runtime-owned attachments. Related text, policy and queue defects made the problem broader than PNG. Tests must cross attachment source protocols with actual persisted Workspace bindings and follow failure through the next queued input.

## Summary

Uploaded images and managed documents entered native file processing and raised a Workspace-required error. Text uploads could instead turn a failed native read into model-visible error text, losing the uploaded body. Materialization failure could terminalize the root, trigger repeated wake attempts against that terminal root and leave healthy queued work waiting. Session-wide progress also attributed one failure to other inputs.

## Timeline

- PR #1469 marked native file readers as requiring a Workspace; the uploaded-text caller retained its catch-and-continue behavior.
- PR #1488 moved file-read evidence into Workspace-owned state. Its `59544acf3195` change exposed the uploaded-image and managed-document caller mismatch.
- On 2026-09-27, the reported managed Desktop failure was traced to preparation before the first model call, with the backend still responsive.
- The 2026-09-28 repair adds managed attachment preparation and tests source transport, extraction, explicit policy, visual child input and queue recovery together.

## Root cause

The ownership changes correctly restricted native file resources, but callers treated an Asset path as an ordinary native file. Workspace-backed fixtures hid the distinction; setting only the ambient context to null also failed to prove that a Project session was actually unbound. The separate data/Asset branches lost explicit image policy and could still extract excluded text. Document support classified audio before media and discarded its binary attachment after extraction. Those adjacent defects are not all attributable to PR #1488.

Known invalid inputs were not consistently parked at the preparation boundary. Generic wake recovery could repeatedly encounter a terminal root, then stop without driving the next item. Its progress state lacked input identity.

## Guardrails added

- [Managed attachment tests](../../packages/harness/test/session/managed-attachments.test.ts) check null and bound Workspaces, transport, explicit policy, source containment and retry.
- [Document tests](../../packages/media/test/session/input-document-extraction.test.ts) run real PDF, DOCX, XLSX and PPTX parsing and reject a complete mixed input when extraction fails.
- [Runtime integration tests](../../packages/media/test/session/managed-attachment-runtime.test.ts) verify provider requests, vision children and healthy work after failed task/steer/context input.
- [Wake tests](../../packages/harness/test/session/wake-retry.test.ts) and [input status tests](../../packages/harness/test/session/input-status.test.ts) cover bounded retry, exact failure identity and queue progression.
- The [decision](../decisions/implemented/bug-fix/2026-09-28-workspace-independent-attachments.md), [architecture](../architecture/session-and-messages.md#assets-and-attachments) and [testing workflow](../../.synergy/skill/testing-guide/SKILL.md) specify the resource distinction and verification matrix.

## Lessons

Filesystem location does not determine resource ownership. A native Workspace restriction requires auditing managed-data callers too. Model invocation success, not upload acceptance alone, establishes attachment delivery; a failed input also needs a healthy successor to establish queue recovery.
