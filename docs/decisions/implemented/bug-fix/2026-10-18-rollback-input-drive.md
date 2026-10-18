# Decision Record: Keep rollback input admission and drive eligibility aligned

Status: implemented

## Problem

A paused Session could retain an earlier root after rollback. New input was then classified as steering that root, although the loop freezes steering during rollback. Scheduling still considered the item runnable, so an owner could repeatedly start and exit without consuming input or calling the model. Separately, submitting an empty running composer invoked Pause, allowing repeated Enter after a send to interrupt execution.

## Decision

Input admission checks effective rollback metadata before resuming a paused root. Input after rollback starts a new task; the retained earlier rollout is not reopened. Runnable inbox checks share the drain boundary: frozen steering cannot wake the Session, while task and passive-input admission retain their existing semantics. These checks do not load message bodies or add frontend requests.

Composer submission has no cancellation intent. Empty submission is blocked, while explicit Pause and stop shortcuts retain cancellation. The rendered composer test checks abort request counts through the actual keyboard handler and primary control.

## Alternatives considered

**Back off repeated wake attempts.** Rejected because delaying an ineligible item does not make it consumable or deliver the user's new request.

**Promote or discard every frozen steer item.** Rejected because rollback preserves queued direction for redo or later work. Admission fixes new requests without changing the meaning or identity of retained items.

**Treat an empty send as Pause.** Rejected because a repeated submit after clearing the draft is not an explicit cancellation action. The primary control and stop shortcuts already provide Pause.

## Consequences

Existing frozen items remain recoverable without a migration. A Session containing only frozen steering stays idle until an eligible action. New input after rollback proceeds as a new root, while ordinary paused input still resumes its original task. Tests cover retained and rootless histories, pause state, repeated drive attempts, redo, keyboard submission and the explicit Pause control. No event payload, subscription or conversation rendering boundary changes.
