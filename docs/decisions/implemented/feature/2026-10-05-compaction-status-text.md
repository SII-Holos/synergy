# Decision Record: Compaction status text

Status: implemented

## Problem

The compact process redesign already gives compaction a chronological row and an existing details panel. Its spinner still competes with the status label. Historical compaction control markers can carry a positive rendering hint even though no body renderer displays them, leaving padded empty rows between the user's request and the process.

## Decision

Compaction uses one selectable line through its running, completed and failed states, with a leading semantic icon in the existing 20px column and an 8px gap before the text. The compaction icon remains static while running text has a repeating gradient sweep between canonical weak and strong text tokens. The stable native button preserves keyboard activation, focus and the owning message identity while the label changes. Terminal outcomes stop the animation. Reduced motion and forced colors retain a steady readable label; failure uses the semantic error icon and color tokens.

The sweep is informed by [OpenCode's TextShimmer CSS](https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/components/text-shimmer.css), adapted to one label without per-character layers or swap timers. The authoritative stylesheet retains the provenance and adaptation beside the implementation.

The existing Session-owned execution detail panel remains the only detailed presentation. Selection uses the attempt's message identity and preserves the read-only, lazy loading and stale-response safeguards established by [bounded process windows and system event details](2026-10-04-bounded-process-windows-and-system-event-details.md).

Conversation body projection excludes control-marker Parts independently of historical rendering hints. Actual attempts and pending manual requests still use the existing message-owned event projection. No storage migration or backend lifecycle change is needed for this presentation correction.

## Alternatives considered

**Keep the rotating icon.** It adds a separate activity affordance when the requested text sweep already expresses that state.

**Remove the leading icon.** This loses the visual alignment and event identity shared with neighboring process rows.

**Expand summaries and failures inline.** This restores large system cards and duplicates the existing details surface.

**Only correct newly generated rendering hints.** Historical summaries would continue producing blank rows until their persisted indexes were rebuilt.

## Consequences

Compaction stays visually quiet and comparable to adjacent process entries. The label conveys activity without implying numerical progress. Browsers without text clipping retain ordinary status text. Regression coverage exercises repeated control markers, lifecycle transitions, native activation, focus retention, theme changes, narrow widths, reduced motion and forced colors.
