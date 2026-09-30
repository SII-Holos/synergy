# Decision Record: Computer, project and main-folder task flow

Status: implemented

## Problem

A combined working-location dialog still exposed independent file and execution choices before an ordinary task. Large explanatory forms and uneven shared controls obscured the primary action. Treating multiple selected directories as display-only project metadata could not give file tools and Worktrees consistent access. A mutable main folder also made the Scope root an unsafe source for historical Worktree maintenance.

## Decision

The ordinary App flow presents computer, project and the applicable main-folder/Worktree choice. Computer is an existing service connection; default execution and files belong to that service. Native picking requires a verified managed Desktop connection, while Web and external Desktop browse the service. The APIs retain independent execution and file capabilities in developer management. No Computer entity or cloud placeholder is added.

Workbench stores versioned project directory references and a revision separately from Scope identity. Folder changes and explicit sharing update in one storage transaction under physical-root exclusion. New projects prepare the canonical project main-folder default outside the retryable storage transaction and before publication; project ownership is checked before preparation and again before publication. Existing Sessions remain pinned to their bindings. Local Runtime captures Worktree source identity, and management resolves each tree through that source rather than the project's latest main. A central startup migration converts the global project/Workspace catalog and distinguishes added folders from historical worktrees without requiring unrelated historical Sessions to converge.

The project Popover, two-field create dialog, independently saved settings and directory browser share flat controls, typography, state timing and theme shadows. Computer, project and conditional folder controls share text emphasis. Frontend optimization is evaluated through complete-page inspection of visual hierarchy, control density and interaction continuity. The precise presentation is owned by [PRODUCT.md](../../../../apps/web/PRODUCT.md#project-first-task-entry); binding and migration semantics live in [Workspace and files](../../../architecture/workspace-and-files.md#product-project-directories).

Suppressing a Tooltip changes its open state without replacing its trigger. Menu-to-dialog handoffs restore the owning trigger before mounting the dialog, so returning focus does not target a removed menu item. Escape dismisses the topmost surface, including a focused path tooltip, before its parent.

This refines the presentation from [project-first task entry](2026-09-29-project-first-task-entry.md), retaining its revisioned draft transfer, connection ownership and folder-picker distinction. The earlier round omitted the combined page's information density, shared-control finish and actual multi-directory semantics; those are required acceptance evidence here.

## Alternatives considered

**Rename the existing resource panel.** This retains too many independent choices and explanations before users can start.

**Move the Scope root whenever main changes.** This changes configuration ownership and can misdirect existing sessions and historical Worktree cleanup.

**Store extra paths only in App state.** File trees would appear multi-root while command and editing authority still pointed at one directory.

**Offer arbitrary execution/storage combinations by default.** This exposes unimplemented cross-machine file coordination; advanced API clients keep that capability without implying a complete cloud-computer product.

## Consequences

The ordinary flow is smaller while developer resource management remains available. Workbench coordinates project persistence and sharing; Local Runtime owns Git sources; App owns pending intent and presentation. OpenAPI/SDK generation covers the new product routes and optional Worktree source fields without changing Plugin UI version. Native acceptance remains distinct from renderer checks, and real multi-directory operations are necessary alongside visual inspection.

The real-host conversation acceptance locates the global Workspace preference by its current “New task starting point” label and verifies the selected Worktree mode after saving and reloading.
