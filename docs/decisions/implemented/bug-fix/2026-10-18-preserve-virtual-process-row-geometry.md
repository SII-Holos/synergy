# Decision Record: Preserve virtual process geometry during disclosure and hydration

Status: implemented

## Problem

Expanding a long process can briefly overlap paragraphs and request bodies outside the intended reading window. Independent zero-height entrances turn the virtualizer's measured rows into a dense list before those same rows expand to their natural heights. Short tool-only fixtures do not expose the resulting demand growth. Independently, asynchronously hydrated bodies can paint at their natural height while neighbouring offsets still use a pending reservation until the next ResizeObserver publication.

## Decision

Manual parent-process disclosure keeps mounted virtual rows at their natural height and uses the existing bounded fade. The virtualizer measures the same geometry that the reader sees. This replaces only the parent-row space-motion choice in [process disclosure preparation](2026-10-08-process-disclosure-preparation-and-motion.md); bounded batch wrappers retain their clipping height transition, pending reservations, conditional mount ownership and reading anchors.

The active outer conversation opts its non-exiting body rows into descendant content observation through Solid Virtualizer’s `observeContent` predicate. Content and descendant inline-style mutations coalesce into one animation-frame content-box measurement batch before the next paint. All reads precede publication, so independent Markdown completions do not each move the viewport. Resolved CSS dimensions can round a precise observer size; content measurements ignore differences within 0.01 px to avoid republishing rounding noise through reading-anchor restoration. Accepted measurements discard older queued observer entries for those targets; the list publishes offsets with the changed bodies. Wrapper position writes do not trigger another content measurement. New and changed body rows also publish measurements inside the existing history-shift transaction. Deferring them until shifting ends can paint older replies over the retained reading anchor even though that anchor itself remains fixed. Other initial rows, automatic exits, nested process lists and ordinary CSS resize delivery retain their existing scheduling outside ResizeObserver delivery. Content measurement does not wait for animation readiness: an admitted viewport may be interactive while another body is still loading. Inactive views do not publish content measurements. Observers and pending targets release on virtual eviction and disposal. Both shipped Solid entrypoints carry the correction.

Body admission, cancellation, version validation and cache budgets retain their existing owners. Long prose tests cover cold reads, accepted-body reuse, narrow columns, reduced motion and CPU throttling. They sample overlap and mounted-row counts during the transition, independently of final layout. See the [diagnosis](../../../postmortem/0080-virtual-process-disclosure-demand.md).

## Alternatives considered

**Continue animating each virtual row's height.** The intermediate zero heights are real inputs to virtualization. Batched measurements alone do not prevent the demand window expanding to the whole process.

**Preload every process body.** Warm local prose reproduces the overlap without network requests. Preloading does not repair geometry and increases transfer and memory cost.

**Publish every resize directly inside ResizeObserver.** That reintroduces nested observer-delivery loops. Content mutation measurement runs before delivery and leaves CSS resize scheduling intact.

**Change the shared disclosure animation.** A bounded activity wrapper can safely animate its height around naturally laid-out inner content. The defect belongs to the parent process's independent virtual rows, so shared dialogs and bounded disclosures keep their behavior.

## Consequences

The parent process stops compressing all paragraphs into a shared area during expansion. It gives up individual row-height interpolation while retaining brief visual feedback, keyboard access and rapid reversal. Demand remains proportional to the visible window; genuinely new uncached history still requires body reads. Transport and stored data are unchanged. Content changes require a bounded synchronous layout read for affected mounted rows; unchanged rows are not polled. Existing history, following, selection, layout-cache and hidden-view regressions remain acceptance requirements.
