# Process event ownership and compaction completion

## Executive summary

Conversation inspection reproduced duplicate Agent deliveries above their chronological position and a manual compaction request that continued displaying a spinner after its attempt completed. Joint Web acceptance also found a historical execution record that remained running after compaction removed its completion evidence from the model working set.

## Summary

The message order in storage was correct. Segmented turn rendering let metadata and footer segments project an Agent delivery owned by another content segment. Manual compaction had a similar ownership mismatch: the request's segment could not see the assistant attempt and continued projecting its own pending row. Independently, detached rollout reconciliation used compacted model history, which can exclude a previously completed root and its reply.

## Timeline

- On 2026-10-04, message-flow inspection traced the apparent Agent ordering error to duplicate segment projection.
- Production Web acceptance reproduced simultaneous pending and completed compaction rows.
- The same acceptance observed an idle session with a previous root's rollout still running after manual compaction.
- Behavioral regressions reproduced request ownership and missing completion evidence, then passed with the corrected projections.
- Full production-browser acceptance exposed a history search target that appeared briefly and disappeared when preceding summaries hydrated; an isolated reproduction and behavioral regression verified identity-based location and interaction release.
- Cold loading with delayed Part reads exposed a latest reply displaced after the forced settling window expired; the production browser regression now delays hydration beyond that window.

## Root cause

Content ownership was inferred from each segment's available messages rather than the complete turn. Metadata-only segments could emit delivery content, and a request-only segment treated an existing compaction attempt as absent. Rollout completion used a model input optimization as execution authority; delayed settlement could run after that projection dropped earlier roots.

History location captured a virtual row index before asynchronous summary replacement finished. Later row insertion and measurement changed that index's owner and displaced the requested Part. A successful initial jump did not establish a stable reading position. Observing only the parent and viewport also missed later content measurements inside a fixed-height parent; CPU throttling reproduced this remaining race.

Initial latest navigation reused a short component settling window. Body hydration could outlive it and move the virtualized latest reply outside the viewport. A layout-driven scroll then captured an intermediate history anchor instead of retaining the user's latest intent.

## Guardrails added

- [Conversation rows](../../apps/web/src/components/session/conversation-rows.ts) own chronological events and replace manual request presentation when any canonical attempt arrives.
- [Segment rendering](../../packages/ui/src/components/session-turn.tsx) restricts delivery projection to its content owner.
- [Rollout reconciliation](../../packages/harness/src/session/rollout/lifecycle.ts) uses effective transcript history with rollback events applied.
- [Conversation tests](../../apps/web/test/components/session/conversation-process.dom.test.ts) verify a single completed event inside its process window; [rollout tests](../../packages/harness/test/session/rollout-continuation.test.ts) verify completion after model history has excluded the root.
- The [testing workflow](../../.synergy/skill/testing-guide/SKILL.md) checks terminal execution evidence separately from session idle status. The [decision record](../decisions/implemented/feature/2026-10-04-bounded-process-windows-and-system-event-details.md) records the ownership rules.
- History location retains the target row, resolves its identity after summary changes and releases correction on explicit reading input. The conversation regression covers delayed preceding hydration and subsequent wheel navigation.
- Latest navigation retains an explicit follow intent until reading input or viewport replacement. Hook regressions cover delayed hydration, queued-jump cancellation and replacement ownership; the production conversation test combines CPU throttling with delayed Part reads.

## Lessons

Virtualized segments cannot infer that an event is absent from a turn merely because it is absent from their own content. Session idle and durable execution completion are separate observations. A model working set optimized by compaction cannot determine historical execution outcomes.
