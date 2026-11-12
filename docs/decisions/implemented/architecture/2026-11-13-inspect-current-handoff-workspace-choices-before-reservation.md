# Decision Record: Inspect current handoff Workspace choices before reservation

Status: implemented

## Problem

Handoff preparation needs the actual source Workspace generation and current Directory control revision. A browser cannot derive these from private history, invent native directory IDs, or reserve an epoch merely to inspect possible destinations.

## Decision

The original Handoff owner exposes a stateless options read for the current execution owner and a selected live destination. It checks both participants' current project execution authority and sharing eligibility. Handoff reader 4 supports a separate, finite inspection signature domain on the existing machine transport. Its immutable tuple binds the original account actor, Session, project, participants, connection, binding epoch and control revision.

The source Runtime reads its actual Session selection and Workspace catalog. The target member reads its canonical local-project default and catalog revision. Replies contain safe labels, logical references and an existing remote resource selection; they contain no native paths or private history. Each callback retains its original Runtime, Store, signal and enrolled Home. The service drains both accepted read exchanges, then rechecks account access, both original connections, current control, binding and sharing generation before returning. The read creates no Handoff, epoch, command or compute allocation.

Choices describe only implemented file mappings. Existing resource discovery supplies separately authorized object destinations. The keep-cloud return includes the actual remote resource and the original member's native default reference, while existing-directory adoption remains unavailable until its complete difference-consent owner is implemented.

## Alternatives considered

**Broaden creator-only private history reads.** Shared execution ownership does not grant access to private bodies, and the UI needs only current selection metadata.

**Prepare a Handoff to discover its inputs.** Inspection must not lock a Session or consume its next binding epoch.

**Trust a caller-selected directory or revision.** The enrolled Runtime and canonical owners supply those references; the later writer must still revalidate them.

## Consequences

The frontend can construct current requests without guessing IDs or native paths. Options are advisory snapshots, never publication or execution authority. Real TLS tests cover native and keep-cloud selections, rejection of a different shared recipient, and a held machine reply invalidated by a concurrent sharing change. Protocol tests verify signature separation and exact participant matching. Main's complete handoff capability remains disabled.
