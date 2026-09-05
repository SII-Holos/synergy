# PR 02 Surface Hierarchy Review

## Local change

Branch: `ui/pr-02-surface-hierarchy`

The first visual pass intentionally changes only shared list and card density. It does not alter routes, data, interaction semantics, or theme seeds.

## Before and after

| Area | Before | After | Intended effect |
| --- | --- | --- | --- |
| List outer spacing | 12px | 8px | Reduce separated-card rhythm and make grouped lists read as one surface |
| List group spacing | 12px | 8px | Reduce vertical fragmentation between related rows |
| List item padding | 8px 12px | 7px 10px | Improve scan density while preserving the existing 44px-class interaction target once content line-height is included |
| Selected row radius | `radius-lg` | `radius-md` | Make selected rows feel like part of the list instead of floating cards |
| Normal card border | `border-weaker-base` | `border-weak-base` | Preserve separation where a card is semantically required while improving edge definition |
| Normal card padding | 6px 12px | 8px 12px | Give card content a more intentional vertical rhythm |

## What to inspect

1. Session and project lists should feel less like stacks of detached blocks.
2. Selected rows should remain obvious without looking like floating pills.
3. Cards containing tool results should retain a clear boundary.
4. Light and dark polarity must remain unchanged.
5. Hover, focus-visible, disabled, and narrow-width behavior must remain available.

## Evidence status

This PR uses a source-level before/after review because the active Synergy runtime must not be restarted or modified. A rendered screenshot set will be captured from the isolated development instance before this PR is considered complete.

## Rollback

Revert commit `packages/ui/src/components/list.css` and `packages/ui/src/components/card.css`; no persisted state or server contract is involved.
