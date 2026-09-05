# PR 03 Control Rhythm Review

## Local change

Branch: `ui/pr-03-control-rhythm`

This pass aligns compact controls around a clearer 24px, 28px, and 32px rhythm. It does not change labels, commands, routes, state ownership, or server behavior.

## Before and after

| Control | Before | After | Intended effect |
| --- | --- | --- | --- |
| Small text button | 22px | 24px | Avoid overly compressed toolbar controls |
| Normal text button | 24px | 28px | Establish a comfortable default control height |
| Normal icon button | 24px square | 28px square | Improve hit target and align with normal text buttons |
| Large controls | 32px | 32px | Preserve the existing prominent action size |

## Evidence status

The source-level review is recorded here first. Rendered screenshots will be captured from the isolated development instance before this PR is considered complete; the active installed runtime is not restarted.

## Review focus

Check toolbar alignment, compact dialogs, session actions, focus rings, disabled controls, and narrow layouts. The expected visual change is less cramped controls without making dense surfaces oversized.

## Rollback

Revert `packages/ui/src/components/button.css` and `packages/ui/src/components/icon-button.css`; no persisted state or server contract is involved.
