# Decision Record: Project-first task entry

Status: implemented

## Problem

Three parallel technical selectors require ordinary users to understand Scope, Workspace and Environment before starting a task. Project navigation can replace a task draft, while shared resource forms mix selection with rebinding and recovery. Native and server folder selection also refer to different filesystems.

## Decision

App owns a project-first task entry with one secondary file/execution summary. Project selection transfers the current new-task draft without navigating to history; destination-first merging checks both revisions and retains uploaded asset references and file provenance. Runtime identities remain canonical after creation. Routine file and execution choices are separate from resource management. Project folders, name and new-task preferences save independently.

Workbench owns a scoped task-default update operation, because the existing generic configuration update writes global configuration. It compares the two edited preference fields atomically and preserves unrelated project settings. The optional execution-profile preference is interpreted by interactive clients, not core Session creation. Local Runtime translates an explicit profile to a generic Harness Environment descriptor so initial binding follows the established reuse policy. A copy's file identity precedes Workspace-reused Environment selection.

Directory selection depends on Desktop's actual managed-service identity, never a localhost heuristic. Other clients use a paginated service directory browser. MDN's [directory picker API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) returns a browser file-system handle; it is not a service filesystem path. No Web local bridge or cross-machine synchronization is introduced.

The native picker uses Electron's [directory dialog properties](https://www.electronjs.org/docs/latest/api/dialog#dialogshowopendialogwindow-options), including `createDirectory` on macOS. Shared Dialog provides an optional fixed footer so project and directory confirmation stays reachable while long forms scroll. A listing response cannot replace a path the user has edited since that request began. Canonical path aliases do not imply an independent copy; only explicit file choices do.

The detailed presentation requirements live in the [Web product rules](../../../../apps/web/PRODUCT.md#project-first-task-entry), resource ownership in [Environments](../../../architecture/environments.md#interactive-task-selection), and file navigation in [Workspace and files](../../../architecture/workspace-and-files.md#service-directory-navigation). This extends the existing [workbench presentation decision](2026-09-29-frontend-workbench-optimization.md) without changing its native titlebar or input semantics.

## Alternatives considered

Renaming three selectors would retain the same mandatory mental model. Reusing global configuration updates could silently change unrelated projects. Allocating a default Environment and rebinding after file selection would violate reuse ownership. Treating localhost as a local-computer capability would choose paths on the wrong machine for external connections.

## Consequences

Advanced operations remain discoverable but require an extra panel. Projects without a configuration folder inherit defaults read-only instead of acquiring a new persistence model. Failed and incompatible references remain visible for repair. The additional scoped defaults and read-only directory routes require generated OpenAPI/SDK updates but no entity or Plugin UI version changes.
