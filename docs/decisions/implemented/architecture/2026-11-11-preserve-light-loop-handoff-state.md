# Decision Record: Preserve Light Loop handoff state

Status: implemented

## Problem

An active Light Loop owns its goal and deadline, while a completed loop retains a terminal record and observer acknowledgement. A Session-only transfer can lose that history, trigger a terminal hook during freezing or reset a deadline when work is continued elsewhere.

## Decision

Register Light Loop as a versioned Session transfer owner. Core carries its canonical Session workflow; the Light Loop owner binds that descriptor with a proof and carries its own terminal record. Private staging validates exact Session ownership, complete proof and terminal presence before paused activation. Publication preserves acknowledgement and error fields without replaying terminal hooks.

The owner cancels live deadline timers and drains the terminal-hook lock during suspension. New terminal and deadline effects use the existing transfer admission gate, including durable source-draining intent. Reattachment skips frozen Sessions. Only an exact cancelled-source or activated-target epoch and independent root Continue can restore the original absolute deadline. Plugin-owned loops require their exact plugin generation portability owner rather than silently invoking an unavailable observer.

## Alternatives considered

**Copy only the workflow descriptor.** This drops terminal outcome and observer-delivery evidence after the workflow has cleared.

**Run terminal hooks while importing.** Publication would become an execution path and could repeat an external effect.

**Restart deadline duration on Continue.** Transfer time would silently extend the original execution budget.

## Consequences

The existing Session and Light Loop stores remain authoritative. Transfer adds a versioned proof and reuses private staging, permanent epoch evidence and the native terminal path. Tests cover a real source-to-target staging roundtrip, terminal acknowledgement preservation, blocked frozen mutations and an expired original deadline that settles only after an independently admitted Continue.
