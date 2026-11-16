# Decision Record: Route dormant remote files through owned Workspace sources

Status: implemented

## Problem

File tools and the file workbench understand local directories, saved object heads and active Executor mounts. A remote service can own a dormant shared Workspace without any of those local authorities. Treating its logical catalog reference as a native directory or copying its content head would create a second writer; treating every failed remote response as a retry would duplicate an uncertain mutation.

## Decision

Harness registers an explicit `WorkspaceFileSource` for each additional backend. Opening normal access requires the original resource origin and produces a finite lease containing a logical reference, virtual directory and existing `WorkspaceFileHost`. The provider retains remote authority and translates logical identities to its own service references. The kernel validates the original Runtime, Store, backend and binding generation, rejects escaped leases, and drains accepted callbacks before releasing their provider. File-only resolution does not select or allocate an Environment.

Local Runtime's `FileView` sends canonical paths, metadata, byte windows, observations and edits through that lease. Ordinary tools and the canonical file service reuse this view. Native, saved-object and active-mount paths retain their existing owners. Remote catalog records do not receive a copied content head or an artificial active mount.

Remote mutations use the existing `WorkspaceOperations` record and active index. Version-one file inputs retain the original provider binding and logical reference independently of native mount inputs. The provider binding is JSON metadata with an owner-defined strict schema; it carries no infrastructure credentials. Initial mutation records commit before dispatch. A verified checkpoint and acknowledgement complete the original operation without publishing a local content head.

Transport uncertainty retains the operation for reconciliation. Cold reopening supplies its original opaque binding in inspection mode, which allows only receipt observation and acknowledgement. An absent or pending receipt stays unknown; neither recovery nor a repeated operation ID resubmits a write or refreshes its original CAS. A different body under the same ID is rejected. Explicit provider `Rejected` failures and confirmed failed receipts settle known no-effect failures without leaving permanent uncertain work.

## Alternatives considered

**Represent remote files as an active native mount.** A file handle does not establish an Environment allocation, native directory, physical mount or compute authority.

**Maintain a member-owned copy of the remote head.** Two independent heads would weaken service CAS and allow a local fallback to appear authoritative.

**Keep another remote-operation ledger.** The existing operation owner already supplies identity, active indexing, maintenance drainage and cold recovery. Adding provider metadata to its versioned input preserves those boundaries.

## Consequences

Focused fixtures run ordinary View, Edit and Save tools and canonical file browsing against an independent real file host. They retain links, byte versions and protected paths while leaving the local content head empty and allocating no compute. Lost acknowledgements reconcile once after Runtime restart; absent receipts remain uncertain without replay. The generic port does not authorize an organization's resources itself: its registered organization adapter must verify accepted task provenance and implement service-backed receipt inspection.
