# Decision Record: Settle popover dismissal before focus assertions

Status: implemented

## Problem

The working-location browser regression could observe its opener still focused immediately after Escape, then fail when opening or closing focus work ran before the next assertion. The popup was still present during its closing animation. The same focus mismatch reproduced locally in one of ten repetitions of the unchanged CI case.

## Decision

Wait for the working-location content to detach before waiting for focus to return to the original native button. Keep the exact focus identity assertion, keyboard dismissal, reopening and chooser callback checks. The test uses the real component and its normal animation without a fixed delay or a larger timeout.

[Kobalte's animation contract](https://kobalte.dev/docs/core/overview/animation) retains content during exit animations. The shared [Popover styles](../../../../packages/ui/src/components/popover.css) use that contract; the [browser regression](../../../../apps/web/test/components/toolbar-selector.dom.test.ts) observes its completed dismissal before asserting the resulting focus state.

## Alternatives considered

**Change production focus handling.** The failing assertion sampled an unfinished dismissal. Adding another focus owner would compete with the existing component lifecycle without evidence of a settled-focus defect.

**Add a delay or retry the test.** A fixed delay would encode the animation duration and runner speed. Retrying the entire case would retain the incorrect observation boundary.

## Consequences

The regression still rejects lost focus after dismissal and now synchronizes on the visible lifecycle it claims to test. It waits for real content removal, so a popup that fails to close remains a failure.
