# Decision Record: Bind local roots without changing project identity

Status: implemented

## Problem

An externally identified project starts with no local filesystem root. Resolving a selected folder as a new directory-derived Scope would change the logical project identity and split its Sessions and configuration.

## Decision

Expose a trusted `Scope.bindLocal` operation that changes the local metadata of an existing project under compare-and-set of its previous local binding. Require absolute selected roots, preserve the project ID and other metadata, and publish the ordinary Scope update event atomically.

Workspace binding and physical identity remain with `WorkspaceBinding` and `WorkspaceCatalog`. A Session created from the newly bound Scope uses the canonical default Workspace. Existing Sessions keep their independently persisted Workspace selection. Selecting a directory does not imply a Git worktree operation or execution authorization.

The organization Runtime exposes authenticated local `orgLocalProject.get/bind` operations. Binding uses an opaque digest of the canonical Scope local metadata for compare-and-set, and commits a stable request receipt with the default change. Responses expose a directory label, Workspace identity and generation without a native path. Desktop selects the directory in its main process; organization membership and Session execution admission remain service-owned.

Desktop's typed project binding bridge resolves the current account's running member, checks its active registration and current project execution access, and captures the private process connection. A native directory picker returns its path only to main; main rechecks account, project and process identity before invoking the generated local API. Renderer results contain a strict ready summary or current conflict summary, with no native path, bearer or arbitrary error data. Document cancellation rejects a late choice before a local write. The project overview starts the member only through an explicit user action.

Signed member Session creation resolves and physically validates the default Workspace before its receipt transaction, then rechecks the Scope and catalog revisions inside that transaction. It binds the explicit native Environment selection without allocating compute. The native composition mode omits personal resource profiles and their default resolver. Hosted composition does not register the native provider.

## Alternatives considered

**Resolve the folder as a new persisted Scope.** Directory and repository identity discovery would replace the externally assigned project ID.

**Persist another project filesystem catalog.** This would duplicate Scope local metadata and Workspace physical binding ownership.

## Consequences

Trusted adapters associate an organization project with a selected folder through existing owners. Concurrent binding changes fail before overwriting the current selection. Real Scope, Workspace and signed service-to-Runtime Session creation fixtures verify identity, compare-and-set, shared new Session defaults, explicit dormant native Environments, request retries and independent existing Session selections. Desktop bridge tests verify current authority after the picker, bounded conflict results, credential separation and cancellation before a late write.
