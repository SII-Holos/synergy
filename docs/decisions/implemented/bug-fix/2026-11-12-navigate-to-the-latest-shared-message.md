# Decision Record: Navigate to the latest shared message

Status: implemented

## Problem

The organization conversation's Latest messages action replaced its finite metadata window without choosing a reading destination. From the oldest page, clicking it left the reader near the start of the replacement window. Assigning the viewport's current `scrollHeight` in a test concealed the missing product behavior and could itself land in the middle after deferred message bodies changed the estimated height.

## Decision

After a successful explicit Latest messages action, the shared transcript asks its existing virtualizer to navigate to the last message with end alignment. The canonical virtualizer owns destination measurement and scroll correction. Initial loading, retries, older-page loading and subsequent events do not acquire a new following policy.

The App regression clicks the product action without assigning its destination on the product's behalf. At narrow and wide widths it traverses 320 messages, hydrates the oldest row, opens the latest window, checks its last readable row, and captures the first screenshot after mounted-body geometry settles. A pixel-content check complements descendant text ranges and viewport hit testing. Diagnostic edge gestures use the actual remaining distance rather than an arbitrary million-pixel wheel delta.

## Alternatives considered

**Assign the current scroll height once.** Its value can still contain estimated row sizes. The existing virtualizer already recalculates an imperative item destination as actual measurements arrive.

**Add another scroll follower.** Latest is an explicit navigation intent. A separate animation, interval or layout correction owner would compete with ordinary reading and the established virtualizer.

**Accept DOM visibility as screenshot evidence.** The original narrow screenshot was blank despite intersecting, hit-testable message ranges. Diagnostic baseline and overscroll variants remain failed evidence; changing capture synchronization does not establish that a production paint defect was fixed.

## Consequences

Latest selects both the current finite data window and its intended last message. Message bodies remain lazy and bounded; refresh failures retain their existing recovery behavior. The regression covers headless browser rendering in both themes, not native macOS overscroll or complete PR acceptance. See the [incident](../../../postmortem/0124-latest-shared-history-did-not-navigate.md).
