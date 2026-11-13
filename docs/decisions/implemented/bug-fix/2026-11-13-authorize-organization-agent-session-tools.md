# Decision Record: Authorize organization Agent Session tools through their object owners

Status: implemented

## Problem

A Hosted Runtime holds native histories belonging to different members. Its generic Session reader resolved any stored identifier without organization authorization, allowing one accepted task to return another creator's private content to its model. Runtime storage residency does not establish the task actor's object access.

## Decision

Harness supplies one composition-owned `SessionReadSource` port. Local Runtime resolves that port before looking up the target Session or hydrating history. Personal compositions retain the existing native reader. Registered sources fail closed on errors and cancellation.

Organization Runtime proves the caller's accepted root and its canonical Session tree before selecting native history. Cross-tree requests use a machine-signed Service API and never hydrate the target's local history. The Service reuses the original accepted command, held execution grant, current connection, effective accepted actor, canonical project roles and Session visibility. Authorization is checked around the finite read. API-token actors currently have no cross-Session tool read capability; their signed acceptance does not broaden the token's project or operation scope.

The shared projection owner resolves message and part versions at one fixed watermark. Reads preserve sharing generation and binding, use bounded message/part/byte windows, and report omitted content. Unsynchronized native changes cannot fill missing projections. Blob references retain their identity but do not implicitly disclose their bytes.

Organization tool catalogs and execution admission share an explicit reviewed capability set. Generic global Session catalogs, Session search/send, process inventory/control, Runtime reload and Agent configuration remain unavailable until their respective object owners provide organization authorization. Cortex's existing exact-parent task visibility remains in force. Optional owners and unknown tools do not acquire permission merely by being registered.

## Alternatives considered

**Authorize a target and then read its complete native history.** A shared object may have unsynchronized or private native changes. Service authorization applies to its current projected generation, not arbitrary bytes resident in a shared Runtime.

**Filter only the visible tool catalog.** Deferred discovery, a stale model catalog or a guessed tool name could still call an unsafe implementation. The same composition policy also checks execution.

**Treat the Hosted Runtime identity as the user.** The machine proves its installed writer and accepted operation. The accepted task actor and current object roles independently determine cross-object access.

## Consequences

Private histories remain isolated even when their files share one Hosted Home. Current-root work remains native, and explicitly shared cross-Session reads return only acknowledged projections. Some generic tools and API-token cross-Session reads have an explicit capability boundary rather than an implicit unrestricted fallback. New cross-object capabilities must first implement their authoritative Service owner and behavioral acceptance.
