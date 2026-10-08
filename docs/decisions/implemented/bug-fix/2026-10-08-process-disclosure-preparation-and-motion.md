# Decision Record: Process disclosure preparation and motion

Status: implemented

## Problem

Cold execution history contains summaries before its leased Part bodies. Measuring the empty body as a finished row shrinks the virtual window, admits more consumers and then removes them when content arrives. This creates repeated reads, cancellations and visible changes in process height. Manual disclosure also exposes space immediately on opening and removes it only after fading on closing. A motion reference owned by the enclosing row retains its conditional content element after removal and starts another animation on that detached element when reopened.

## Decision

Conversation rows reserve one compact activity line per summary Part while their page or leases are pending. The inner process virtualizer starts with the average summary-based row estimate instead of an unrelated constant. The same estimator supplies both reservation and initial virtual geometry; accepted body sizes continue through the existing measurement owner. Errors count as settled content and retain the existing retry surface. Body consumers still release immediately when their owning row leaves.

Manual batch disclosure owns height and opacity motion on its bounded outer content wrapper. The inner vertical viewport retains its natural geometry during the outer clipping transition. Manual parent disclosure grants one generation to its newly visible and already mounted exiting rows; their wrappers own space motion, while Parts keep their existing arrival rules. The intent survives summary preparation until process rows appear, and an active entrance survives unrelated projection updates. Height keyframes temporarily release the wrapper’s minimum height so pending reservations cannot block contraction; settlement restores normal geometry. The first settled entrance expires that generation for later virtual mounts. Completion and restored history do not acquire a manual entrance. Rapid reversal keeps the current painted height, opacity and transform, and cancelled completion callbacks cannot remove reopened content.

Motion references clear their element when the specific conditional mount disposes. Visibility is memoized separately from changing row data, so unchanged visibility does not restart or settle an animation because another prop changed. Animation and reduced-motion listeners dispose with that binding. The existing viewport retains responsibility for reading anchors, native input and resize compensation.

The diagnosis and controlled geometry experiment are recorded in [the disclosure postmortem](../../../postmortem/0059-cold-process-disclosure-jank.md). The owning implementations are `apps/web/src/components/session/conversation-rows.ts`, `virtual-conversation-rows.tsx` and `packages/ui/src/utils/disclosure-motion.ts`.

## Alternatives considered

**Add opacity animation without preparing geometry.** Opacity cannot stop empty-row measurements from changing virtual membership or prevent the content window from shrinking and growing during a fade.

**Hydrate the whole process or retain cancelled reads on a timer.** Eager reads scale with history rather than the viewport. Delayed lease release conceals unstable membership, retains unnecessary bodies and adds another asynchronous lifetime. Summary-based reservation preserves the existing bounded demand and cancellation model.

**Animate individual Parts or every virtual remount.** Nested height animations multiply measurements and can disturb native reading. Space motion belongs to the bounded wrappers affected by the explicit disclosure; later remounts and accepted history remain static.

## Consequences

Pending rows occupy estimated space until success or visible failure settles their leases. The estimate uses the established compact 28 px activity line and Part count; it is not a claim about the final height of prose or expanded reasoning. The virtualizer accepts actual sizes after hydration and uses its existing width-scoped layout cache. Focus, selection, live append, history prepend and reduced motion remain governed by the same owners. Tests delay real SDK-backed Part reads, bound retained consumers, reject duplicate same-version reads and detached animations, and exercise parent/batch independence plus interrupted space motion without replacing the final answer.
