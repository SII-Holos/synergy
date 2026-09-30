# Native titlebar swallowed workbench controls

## Executive summary

The desktop sidebar restore, Search, New and side-workspace buttons could appear enabled while ordinary mouse clicks did nothing. The full conversation header was a native drag rectangle overlapping buttons owned by sibling subtrees. Renderer-level automation and accessibility activation passed without exercising that native hit test. Keep dragging inside unoccupied header geometry and verify controls with OS-level pointer input.

## Summary

The built-in sidebar collapses to zero width and moves its controls over the conversation header's leading padding. The side-workspace toggle stays at the full session's outer corner through a Portal. Both sets of controls retained `no-drag`, but the independent full-width header still occupied their native hit area.

## Timeline

- 2026-09-29: production Web and Electron checks verified geometry, state transitions and injected clicks.
- 2026-09-29: the user reported that the top-row buttons behaved like the titlebar.
- 2026-09-29: OS-level coordinate clicks reproduced unchanged sidebar and workspace states. A new production native geometry assertion failed on the workspace toggle's overlap with `stb-root`.
- 2026-09-29: the header drag region was limited to its empty flex span and the native verification procedure was amended.

## Root cause

The visual stacking hierarchy was treated as evidence of native pointer reachability. Electron's drag region consumed clicks before the renderer's handler ran, even though the relocated buttons had their own non-draggable styling. The native verifier exercised Electron window state but used Playwright input for page controls; accessibility activation likewise reached handlers without establishing mouse reachability. Checking a button's own computed `no-drag` value missed the overlapping drag owner.

## Guardrails added

- The [titlebar styles](../../apps/web/src/components/app-shell/desktop-native-titlebar.css) restrict session dragging to an empty flex span.
- The [native production verifier](../../apps/web/test/fixtures/workbench/verify-native-chrome.ts) rejects overlaps between drag rectangles and controls in other subtrees, in ordinary/fullscreen, expanded/collapsed and split states, and retains an empty draggable span.
- The [frontend verification workflow](../../.synergy/skill/develop-frontend/SKILL.md) requires OS-level coordinate clicks and distinguishes them from injected or accessibility actions.

## Lessons

Native window-state coverage and renderer interaction coverage are separate from native pointer hit testing. A passing click handler test does not establish that a physical pointer event can reach that handler.
