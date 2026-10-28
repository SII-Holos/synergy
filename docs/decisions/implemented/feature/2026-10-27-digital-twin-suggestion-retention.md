# Decision Record: Retain next-input suggestions while drafting

Status: implemented

## Problem

Editing an unsent draft does not establish that the user has rejected a generated suggestion. Discarding the suggestion during typing, completion acceptance or an input-method composition prevents the user from returning to it by clearing the draft and can require another model call for unchanged context.

## Decision

Digital Twin separates the lifetime of its saved suggestion from whether the composer can display it. Draft text, shell mode, composition, attachments and other temporary blockers hide the completion while preserving the existing per-server, Scope and Session record. Clearing an unsent draft restores the same text and proposal identity through the document completion service without inference, including after Tab acceptance, navigation or reload.

Explicit dismissal clears the record. A different canonical root message, accepted Inbox input or a superseding completed reply also clears it. Optimistic messages and busy status hide presentation but do not establish accepted input, so a failed send can return to the saved suggestion. The saved format, automatic completion claims and assistance provenance remain unchanged.

These retirement conditions supersede the editing and acceptance conditions in the [original next-input decision](2026-10-21-digital-twin-next-input.md). The component, inference and evidence-selection decisions in that record remain applicable.

## Alternatives considered

**Discard on every draft change.** This treats a reversible edit as a permanent rejection and loses a useful result before the user sends anything.

**Generate another suggestion when the draft becomes empty.** This adds model cost and latency, can return different wording and replays an automatic trigger without a new completed turn.

**Discard when submission starts or the Session becomes busy.** Optimistic display precedes server acceptance and can be rolled back. Busy status alone cannot distinguish accepted input from temporary activity.

## Consequences

One existing saved suggestion remains available during drafting; no additional history or storage migration is needed. The user can explicitly dismiss an unwanted suggestion. Accepted or superseded suggestions cannot return after reload, and restored suggestions retain their assistance identity when accepted again.

The rendered composer tests cover input and clearing, Tab acceptance, composition, mode and blocker changes, pending and failed submission, remount and reload, explicit dismissal, canonical new input and accepted queued input. They assert that restoration does not request inference and replace the obsolete edit/acceptance deletion cases.
