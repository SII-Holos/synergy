# Decision Record: Make Desktop startup progress observable

Status: implemented

## Problem

Long startup upgrades report useful aggregate counts before HTTP is available, but an unknown total hides those counts in the overlay. A numbered migration without a task name and clocks makes it difficult to distinguish advancing work from a silent interval. A moving bar alone cannot answer that question.

## Decision

Desktop presents preparation, updates, recovery and workspace opening as a small stage list. The current task, migration step, checked count, step and total elapsed time, and last-progress age stay visible. Percentages describe only a current task with a known total; unknown totals retain checked counts and an explicitly indeterminate bar. Maintenance without item-level progress keeps its operation and waiting time visible.

The shared startup schema adds an optional enumerated `task`. CLI maps known migrations to these public categories and omits unknown classifications. Migration IDs, descriptions, paths and record content do not enter the stream. Desktop accepts older records without a category. Classification and presentation remain in their consumers; migrations and storage retain their existing owners.

Accepted progress events anchor the clocks. Discovering a total cannot reduce checked counts. Duplicate counts, stale steps, regressive or duplicate maintenance stages and ordinary logs do not reset the last-progress age. Local timer ticks update elapsed labels only, and retries cannot decrease the total elapsed time. After 30 seconds of silence, unknown-total motion pauses and explanatory copy appears without declaring success, failure or continued backend activity. Accepted progress resumes the animation. Existing inactivity and fixed engine deadlines retain their behavior.

The page uses the persisted Desktop skin's text, muted text and border colors, a restrained brand mark and one aligned reading column. Unknown-total motion stops under reduced motion. The page can scroll in short windows and reflows at narrow widths and increased zoom. Count-only updates preserve task announcements, and the live title retains heading semantics for screen-reader navigation. Custom window controls receive native state directly in the startup view before the application renderer is ready; delayed initial or action replies cannot overwrite newer state.

## Alternatives considered

**Estimate a global percentage or completion time.** Pending work and independent scan totals are not uniformly available, and equal weighting would imply precision unsupported by actual work. Task-local percentages and explicit unknown totals preserve the available evidence.

**Forward migration descriptions or logs.** Arbitrary metadata can contain private identifiers and implementation details. An enumerated category supplies a useful name while preserving aggregate-only framing and bounded output.

**Renew progress periodically to keep startup alive.** Timer-driven progress would hide stalls and weaken finite waiting limits. Display clocks describe inactivity without changing admission or deadlines.

## Consequences

Users can see advancing unknown-total work and assess how long a step has been silent. The change improves waiting feedback without reducing the underlying migration or build cost. Known task classification requires maintenance as migrations evolve; unclassified work retains a generic label and real counts. Behavioral tests cover protocol privacy, producer emission, accepted-event clocks and deadlines, plus actual Electron rendering, reflow, zoom, reduced motion, live theme changes, stable task announcements and keyboard window controls with delayed state delivery.
