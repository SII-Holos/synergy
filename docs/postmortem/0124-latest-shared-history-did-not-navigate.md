# Latest shared history did not navigate

## Summary

The organization conversation's Latest messages button fetched the newest finite page but left its reading position near the beginning of that page. An earlier App test supplied its own scroll-height assignment, so it did not exercise the complete product action. Removing that assignment reproduced a missing final message at both 375 and 1100 pixels.

## Timeline

1. A 320-message fixture exposed ordinary word splitting and an intrinsically widened message grid. Those fixes were committed separately while a blank narrow screenshot remained unaccepted.
2. One captured browser bundle compared the original edge gesture, an overscroll-style variant and a gesture limited to the actual remaining distance. The original narrow latest screenshot had zero non-background pixels despite DOM visibility; the style variant also failed to reach its expected final heading. The finite gesture was readable at both widths. These observations did not prove a production compositor fix.
3. Cached-bundle diagnostics showed the replacement window at messages 292–301 after the test's single estimated scroll-height assignment. Later body measurements had changed the total height. The product action itself performed no item navigation.
4. The real App regression removed that assignment and clicked Latest. Both widths timed out waiting for message 319, with 74 preceding assertions passing.
5. The product action now delegates its final-message destination to the existing virtualizer. Four focused App cases passed 144 assertions, including the two archive sizes and existing private-field/tool-attachment readers. The first oldest/latest images were readable in both themes and retained their pixel checks; the original failed evidence was not replaced by screenshot retries.

## Root cause

Fetching a recent metadata window and navigating a virtualized reader were treated as the same operation. The test compensated for the missing navigation by setting the viewport directly, before asynchronous canonical body rendering had finalized its measurements.

## Guardrails

- [x] Machine check: `apps/web/test/organization/sessions.browser.test.ts` traverses all ten finite pages and requires Latest itself to reveal the final message, without test-owned destination scrolling.
- [x] Machine check: the same fixture retains mounted-row bounds, descendant word and text ranges, lazy-body request counts, read-only request checks and first-image pixel content at narrow and wide widths.
- [x] Owning procedure: the frontend presentation Skill distinguishes current-page retrieval, explicit reading navigation and settled paint evidence.

## Lessons

Test the user's complete action before adding low-level browser movement. A hit-testable DOM row is not sufficient visual evidence, and an estimated virtual height is not a stable item destination. The [decision](../decisions/implemented/bug-fix/2026-11-12-navigate-to-the-latest-shared-message.md) keeps navigation within the existing scroll owner.
