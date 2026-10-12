# Decision Record: Conversation latest control visibility and placement

Status: implemented

## Problem

The conversation's follow state also protects reading inside bounded process windows. Using that state alone to show return-to-latest conflates paused following with unseen outer content. Positioning the control above the complete dock also makes activity avatars and progress increase its distance from the editor.

## Decision

The conversation viewport measures remaining outer scroll distance on native scrolling and observed layout changes. Its floating control requires both the existing detached state and content below the viewport. Nested scroll deliveries do not update outer scroll state, while process interaction continues to protect reading anchors.

The built-in session shares its mounted dock-body element with the viewport through a local context. The control aligns with that body's right edge and clears it by 12px, constrained to the conversation viewport. Decisions and navigation links belong to that body; activity remains separate and reserves lateral space for the control. Full dock height continues to determine transcript clearance. Custom viewport offsets and layouts without the built-in anchor retain their existing positioning path.

## Alternatives considered

**Stop propagating all process interactions.** That removes the false visibility signal but also allows outer following to disrupt deliberate reading and disclosure. Measuring actual overflow preserves both behaviors.

**Subtract a fixed activity height from the dock.** Avatar counts, workflow offers, editor resizing and narrow layouts make the offset variable. Measuring the mounted body avoids another independently maintained height estimate.

**Move the control into the dock through a portal.** The control would leave its conversation's admission and inert lifecycle. Sharing only geometry retains conversation ownership and its existing activation path.

## Consequences

The viewport owns an additional ResizeObserver for overflow and anchor geometry. Measurements precede reactive writes, unchanged positions retain their object identity, and cleanup follows the mounted owner. A production browser fixture covers internal wheel and keyboard reading, subsequent outer growth, return activation, activity visibility, input resizing, light and dark themes, mobile stacking and pending decisions. The fixtures retain existing dock-height and reading-anchor tests because they protect distinct behavior.
