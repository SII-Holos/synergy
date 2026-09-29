# Decision Record: Non-activating Computer background input

Status: implemented
Archived: 2026-09-29

## Problem

Cua's background raw left-click policy can make a target application active without raising its window, then restore the prior application. A background argument and matching foreground PIDs at the end cannot establish that the user's focus remained uninterrupted. An acceptance fixture that activates itself before testing can also conceal this distinction.

## Decision

Synergy's guarded pixel actions select target-activation suppression and cannot enter the activation-without-raise or foreground-assistance policy. The observation guard still requires background delivery, exact native identity and valid image evidence. Unsupported background operations refuse or return an unverified effect; they cannot silently escalate to foreground input.

The coordinate-to-AX optimization only presses elements that advertise `AXPress`. An AX hit on a window or another container without that action must continue to the admitted pointer route; a successful AX return code alone does not prove a supported press or a visible effect.

Guarded actions do not arm upstream focus-restoration leases: a user may deliberately switch applications during an operation. The private worker disables the cursor overlay and reuses Cua’s [AppKit loop without an overlay window](https://github.com/trycua/cua/blob/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver/rust/crates/platform-macos/src/pip/mod.rs). It creates no driver window and makes no activation request. Desktop remains the owner of permission and progress presentation.

Disposable native fixtures open behind the user's application. Acceptance records application-activation notifications, foreground changes and Space changes across observation and mutation, including transient changes later restored. The real-model acceptance uses the same independent event oracle alongside its visual code, target counter and submitted image receipt.

The [observation admission decision](2026-09-29-computer-observation-admission.md) owns target and image proof. This restriction also applies when an upstream operation uses the word background.

Provenance: [Cua's pinned click implementation](https://github.com/trycua/cua/blob/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver/rust/crates/platform-macos/src/tools/click.rs). Local adaptation: restrict activation policy for Synergy's guarded calls while preserving upstream policy for other callers and retaining its background input routing.

## Alternatives considered

**Allow activation without window raising.** This can still divert keyboard focus and does not satisfy background execution.

**Restore focus after every operation.** Restoration hides transient interference, may fight the user's own focus change and cannot undo typing sent to the wrong application.

**Bring the fixture to the front for acceptance.** This tests an easier condition and can hide a focus dependency in the input path.

## Consequences

Background execution preserves the user's active application instead of optimizing for input success through implicit activation. Some applications can require a semantic route or report unavailable or unverified input. Application-specific reactions remain a native acceptance concern; source routing alone does not prove behavior across all applications or macOS versions.

This restriction does not establish successful background delivery to opaque canvas controls. The independent hit-counter and continuous focus checks must both pass before that scenario can be accepted. Do not make a fixture accept first mouse, activate it during setup, or treat a posted event as completion to satisfy this gate.
