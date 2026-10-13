# Visual cards replaced by their source attachments

## Executive summary

Full-page acceptance of native Render exposed an existing activity-projection collision: a tool card and its promoted attachments shared one visibility-map key. The latter replaced the former, leaving two source-file cards and no visual. Component tests mounted Render directly, while projection tests covered cards and promoted files independently. Presentation identity must account for multiple faces of one Part.

## Summary

The server returned a completed native visual and classified its summary as content. The conversation nevertheless displayed only source attachments. The same collision affected HTML visuals carrying a source attachment.

## Timeline

On October 10, isolated source acceptance generated a visual through the real session loop with a synthetic provider. The backend source was correct, but the visual heading never appeared. Inspecting the final timeline identified two attachment rows referencing the producing tool Part. An expanded projection regression reproduced the replacement before the fix.

## Root cause

`projectAssistantActivityItems` indexed visible items using message and Part IDs. `collectSessionTurnTimelineItems` legitimately emitted both a tool card and a `tool-attachments` item for that Part. Both source entries then resolved to the attachment item. Final keys reflected the replacement, so stable DOM reconciliation could not recover the card.

## Guardrails added

Attachment visibility identity now uses its existing presentation key; ordinary Part identity still supports reasoning promotion. The [projection test](../../packages/ui/test/components/session-turn-activity.test.ts) retains both card and attachments and checks unique final keys. The [frontend workflow](../../.synergy/skill/develop-frontend/references/state-and-recovery.md) requires this combined projection evidence. The [native catalog decision](../decisions/implemented/architecture/2026-10-10-native-render-catalog.md) records the boundary.

## Lessons

A successful source read and an isolated component render do not establish conversation presentation. Verify through the full page when one producing Part has multiple visible outputs.
