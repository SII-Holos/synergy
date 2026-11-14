# Decision Record: Align knowledge publication with project execution

Status: implemented

## Problem

Project knowledge controls used membership-management permission for publishing, new versions and withdrawal. The publication service instead authorizes project execution, so collaborators lost permitted actions while archived maintainers retained actions the service would reject. Direct management links also left an empty pane when the corresponding navigation item was hidden. A pending withdrawal read its revision from later catalog metadata rather than the user's original confirmation.

## Decision

Project publication controls consume the existing execution-permission projection. Organization publication keeps its separate administrator qualification. Version and file reading remain available without write permission. Losing write permission retires the open publication editor and exact owned confirmations without changing the accepted status of an already dispatched server operation.

Withdrawal snapshots item identity and revision when its confirmation opens. Its callback requires the same captured Space and permission generation before dispatch and UI completion. Metadata refresh does not silently upgrade an old confirmation to a newer revision; the service's existing revision comparison resolves a real conflict.

Members and Resources deep links without management access render the shared access message and an ordinary permitted route back. A project reader retains its readable project and Overview navigation. These views do not request the prohibited catalog. Server authorization remains authoritative for every actual operation.

## Alternatives considered

**Gate every change with management permission.** Membership administration and publishing authorize different work. A nearby permission flag cannot substitute for the publication owner's rule.

**Copy role tables into the frontend.** The service already supplies effective project permissions, including archive state. Duplicating roles would create another interpretation and miss concurrent lifecycle changes.

**Refresh the confirmation's revision at click time.** That authorizes a newer object than the one the user reviewed. Retaining the observed revision allows the canonical service conflict response instead.

## Consequences

The App fixture exercises collaborator, reader and archived publication states at narrow and wide sizes, original applied-version behavior, denied organization/project management deep links and a catalog refresh behind a withdrawal confirmation. Existing organization-level publication and project recovery cases remain in the same focused recipe. No API, role matrix, publication receipt or server admission semantics change. Unknown publication recovery across renderer reload remains a separate workflow.
