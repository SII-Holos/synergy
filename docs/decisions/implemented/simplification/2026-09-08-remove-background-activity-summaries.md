# Decision Record: Remove background activity summaries

Status: implemented

## Problem

Balanced activity rows do not display generated group summaries, yet tool updates trigger auxiliary model calls whose recording failures can interrupt the owning task. Minimal display can calculate useful action counts directly from the existing tool parts.

## Decision

Remove the activity-summary internal agent, prompt, event subscriber, metadata writer, and lifecycle drainage. All display modes derive activity presentation locally from message parts. Ignore historical summary text and group signatures without deleting stored metadata or changing the message wire schema. Title generation, turn summaries, context compaction, and evidence recording retain their independent owners.

## Alternatives considered

**Disable only Balanced inference.** This leaves the same auxiliary lifecycle and failure exposure for Minimal mode, where deterministic counts already provide progress.

**Add visible generated group headings.** This adds a product surface and model cost that the flat tool-row presentation does not need.

## Consequences

Activity presentation consumes no model calls and cannot hold task completion waiting for summary work. Semantic grouping and the Minimal model-generated now line are removed; tool rows, counts, receipts, and reasoning presentation remain available. This removes one trigger of recording failures but does not change transport cancellation or suppress failures from other recorded calls.
