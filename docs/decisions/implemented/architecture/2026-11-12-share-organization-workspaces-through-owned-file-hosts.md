# Decision Record: Share organization Workspaces through owned file hosts

Status: implemented

## Problem

An organization Workspace has one service-owned object head, but a member Session's ordinary native execution preparation rejects cloud infrastructure. Selecting that resource must provide authenticated remote files without cloning the head into each member Home or starting compute. Retrying a write after a lost response must preserve the original version and operation identity.

## Decision

Organization Runtime registers a private Session file API through its selected HTTP component. It resolves the Session's actual accepted Inbox/root and canonical Run through the existing member execution owner, binds the original resource grant, and dispatches through a remote `WorkspaceFileHost`. Both local and organization transports use generated SDK methods. Ordinary native execution retains its cloud-infrastructure rejection; generic FileTools and the Web file panel do not consume this new API.

Each machine request signs its complete operation, original organization/project/resource/Workspace identity, binding generation and revision together with the original finite accepted root proof. File signatures use a distinct purpose and the enrolled machine's existing key. The service derives callback-only authority from the verified request, current connection, exact retained grant and current Session resource contract. Caller-provided object identities cannot select another resource. Subsequent shared tasks retain the established Session resource selection; explicit resource disablement and current machine/project eligibility remain enforced.

Reads use the canonical Workspace content owner for metadata, literal links and bounded byte windows. Directory continuation binds the actual canonical child path and catalog revision, reusing its seekable children iterator. Writes prepare immutable content before SQL and publish the existing content head with a purpose-separated operation receipt in the same transaction. The original Runtime, primary Store, namespace, request signal, finite proof and connection guard remain attached through final commit. An escaped callback loses its authority.

The existing cloud receipt owner keys file receipts by accepted Session/root, binding and original client operation identity. Same-body retries return the original result; changed bodies or stale CAS fail. Receipt inspection reauthorizes the current owner and never publishes. An absent receipt remains uncertain until the original owner is consulted; the adapter does not silently refresh a revision and resubmit. Active physical file callbacks prevent release or handoff closure of their retained grant, and service shutdown drains accepted HTTP work.

## Alternatives considered

**Copy the cloud head into each member catalog.** Independent heads would break shared CAS and make a local native fallback appear authoritative.

**Authorize files from enrollment or an unsigned root label.** Neither establishes the selected Session's accepted task, current retention or complete operation. The existing signed root proof and callback-bound request owner provide those checks without another authority ledger.

**Enable all cloud execution through the file adapter.** Dormant object files do not implement compute, mounts, blob imports or WorkspaceMove publication. These operations reject explicitly. Handoff mapping, complete remote move receipts and Session activation remain separate required integration work; Main handoff capability remains disabled.

## Consequences

Two enrolled member Runtimes share one actual service head through registered Session file APIs while retaining empty local Workspace catalogs and zero compute allocations. Focused tests exercise binary bytes, prefix siblings, literal links after relocation, sensitive/read-only paths, stale CAS, signed-body tampering, lost responses with cold receipt reconciliation, physical drainage, resource disablement and final transaction rollback. The protocol is additive; purpose-separated version-one file receipts do not reinterpret existing browser cloud-write receipts. Existing cloud locators and content schemas require no backfill.
