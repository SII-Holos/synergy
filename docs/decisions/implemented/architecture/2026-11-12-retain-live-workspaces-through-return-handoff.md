# Decision Record: Retain live Workspaces through return handoff

Status: implemented

## Problem

A Session using organization files cannot return through a native-directory capture: its Locator has no local path or physical claim. Reusing its outbound file graph would also lose cloud edits made after the first handoff. The return must preserve the same Session and service resource without turning a shared Workspace into an exclusive directory transfer.

## Decision

The explicit organization-live mapping binds the source Runtime's logical Locator generation and its existing service resource, Workspace generation and subtree. Both machine peers negotiate handoff reader 3. The service verifies the Session's retained resource selection and current participant ownership; this path does not select another resource or grant new execution authority.

The original physical source owner drains the exact Session cohort and native processes. The organization portable owner also waits on each member's original file-resolution lock after its native epoch closes new binding, so accepted API and tool callbacks settle before capture. A composition-registered remote source retains its exact Locator metadata in that owner's temporary inventory, without creating a directory claim, mount or local content head. Its finite callback captures the current dormant service head through the canonical Archive subtree operation. That operation links existing indexed chunks, preserves literal supported internal links and verifies the complete reachable graph without rereading unrelated file bodies. The original Handoff record retains the snapshot only while its actual Workspace generation, revision and head still match. The record's authority projection includes the snapshot; a derived object-membership index restricts signed machine reads to that snapshot's reachable hashes. A retained snapshot never refreshes to a newer head on retry.

The source copies this verified graph into its existing private portable file closure. Organization transfer reader 5 carries the complete service snapshot in the aggregate root header, separately from a nullable WorkspaceMove receipt. Readers 3 and 4 remain explicit history inputs. Source-frozen and target-prepared facts preserve the snapshot hash. The target verifies the staged graph, header and current service authorization before publishing a version-two remote Locator with Core and the existing native epoch transaction. It never publishes a local copy of the service head. Private preparation uses the Workspace owner's retained creation time so a new finite machine plan cannot change a previously prepared Locator after an interrupted validation.

Returning to the original Runtime derives its prior surrendered source binding through the canonical epoch owner and supplies the existing supersession validation. The prior surrender record remains immutable. The target keeps the original Session ID, advances its binding epoch and stays paused. [Source sync drainage](../bug-fix/2026-11-12-drain-shared-export-before-source-surrender.md) prevents a retained old projection queue from disconnecting that Runtime during the return.

## Alternatives considered

**Capture the old native directory or outbound graph.** Either can differ from the current service files and would misstate what the returning Session uses.

**Download cloud files by default.** The specified default retains the shared cloud resource. Downloading would introduce local publication, collision and difference-consent requirements that this path does not establish.

**Lock the complete shared Workspace for the Session handoff.** A point-in-time portable snapshot and ordinary shared live view are sufficient for this path. Unrelated Sessions retain their existing concurrent access.

**Create another handoff or epoch ledger.** The original record owns the snapshot and the original epoch owner validates return supersession; derived object membership is not another phase authority.

## Consequences

The opt-in Runtime supports native-to-object transfer followed by a default keep-cloud return to the original member with the same paused Session. The original native directory remains unchanged. Explicit existing-directory difference adoption, native download, additional current Working locations, remote compute and independent Continue acceptance remain separate work; Main's complete handoff capability stays disabled.

## Verification

The real TLS two-Runtime Workspace fixture changes cloud binary bytes after outbound activation, reads those changed bytes from the actual return source closure, verifies the complete snapshot hash, interrupts validation after private target preparation, retries the same handoff and activates the original Session at epoch 3. It verifies an unchanged service head and original native directory. A real remote writer held in the service BlobStore prevents source-owner freezing until its write and original callback settle; later native binding is rejected. Archive tests exercise a multi-page subtree with no body rereads and reject caller-mutated source identity; epoch tests retain the old surrender record. Existing native target and claim-drainage tests remain applicable.
