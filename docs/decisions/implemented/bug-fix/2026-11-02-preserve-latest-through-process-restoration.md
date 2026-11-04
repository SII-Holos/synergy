# Decision Record: Preserve latest following through process restoration

Status: implemented

## Problem

Returning to the latest conversation can remount a virtualized process with a saved reading position. Reporting that passive restoration as a new interaction cancels the outer viewport's latest intent. It can interrupt an active scroll animation or leave subsequent output below a detached viewport.

## Decision

`ProcessViewport` restores its saved offset, anchor and local reading notification without emitting `onInteraction`. Actual reading gestures, disclosure actions and explicit navigation keep their existing interaction callbacks. The outer viewport remains responsible for its own following intent.

The process restoration tests verify retained paragraph offsets and reading notifications without an additional interaction. The conversation regression returns from earlier content through a remounted paused process, then appends an answer and verifies that the outer viewport stays at the bottom.

## Alternatives considered

**Ignore interactions briefly after returning to latest.** A timeout would also discard genuine user input and would not cover delayed hydration reliably.

**Discard the saved process reading position.** That would lose independent local reading on virtual remount. Preserving the local state without synthesizing user input resolves the conflict at its source.

## Consequences

Virtual remount preserves local reading and retention without cancelling outer navigation or following. Real reading input retains its immediate precedence. No timers, extra scroll controllers or new public interfaces are introduced.
