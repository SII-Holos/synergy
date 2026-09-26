# Decision Record: Preserve canonical Inbox restoration

Status: implemented

## Problem

The UI reconstructed removed queue items as new ordinary input, losing mode, no-reply behavior, hidden variant and other execution configuration. Restore failures were swallowed.

## Decision

Move user-removed stored items into a Session-owned recovery collection atomically. Restore the original item and retain a receipt after restoration so repeated responses cannot recreate consumed work. Public APIs expose only existing public item projections.

## Alternatives considered

Keeping only a frontend snapshot cannot survive reload or preserve private canonical input. Reusing normal input admission changes paused-session and mode semantics.

## Consequences

The additive collection needs no historical rewrite; old installations read an empty removed list. Session deletion removes recovery records. Transcript export/fork exclude queue state. The Web inbox keeps local errors and a Removed messages section; restoration follows ordinary scheduling without implicitly resuming a pause or rearming failure.
