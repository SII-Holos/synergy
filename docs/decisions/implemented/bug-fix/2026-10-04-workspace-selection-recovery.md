# Decision Record: Make directory selection and recovery explicit

Status: implemented

## Problem

Directory recovery can open management without a Session or draft destination, leaving a highlighted row with no action to apply it. Identical directory names hide the paths needed to distinguish working copies. Background rebinding can also replace the generation a user originally selected without another confirmation.

The disabled composer repeats its recovery reason beside the button and twice in its tooltip. Queueing repeats the same action as both tooltip title and hint.

## Decision

The chooser requires an explicit draft callback or Session destination for selection and recovery. Standalone management has a distinct close-only mode. Submission failures preserve their directory reason and actual failed Session identity across the new-Session handoff; another connection, Scope or Session cannot receive that recovery.

One flat list shows directory names, full paths and known branches, with available current and main entries first and unavailable entries last. Recovery highlights the failed binding for repair while retaining the actual current location's label and priority. Clicking a row preserves order. A fixed footer applies the selected location, while management and creation use separate views. Confirmation returns to the composer without sending the retained prompt.

The composer shows a blocking recovery reason once beside Send, associates it with the button through its accessible description, and suppresses that button's redundant tooltip. Action tooltips keep additional guidance only when it adds information beyond the action label.

The selected binding generation remains captured until the user selects again. A failed binding stays unavailable for recovery at that generation even if the catalog still describes it as bound. Explicit repair advances the generation under the existing [verified-identity rule](2026-09-23-unverified-workspace-directory-bindings.md). Session selection and shared-resource changes retain the existing generated API and revision checks.

## Alternatives considered

**Show the existing confirmation button for every management dialog.** Management does not always own a Session or draft. Making the destination explicit prevents a button from promising an operation it cannot perform.

**Group or collapse working copies.** A flat list preserves direct comparison and search. Paths and branches distinguish records without introducing another navigation step.

**Apply selection or resend immediately on a row click.** Highlighting expresses a pending choice. Explicit confirmation lets users inspect similar paths, and manual sending preserves control over the retained prompt.

## Consequences

The list contains more metadata per row and management takes a separate navigation step. Users can identify similar directories and always reach the confirmation action. Recovery preserves conversations, drafts, file ownership and shared rebinding semantics without changing persisted state or server schemas. Browser regressions cover draft application, cancellation, stable ordering, path and branch search, generation conflicts, repair, file collections and narrow footer reachability. Rendered composer regressions cover one recovery explanation with an accessible description and one queue action label.
