# Decision Record: Verified installation generations

Status: implemented

## Problem

Optional in-process components require a module graph that can be verified before Harness is imported. Mutating that graph in place can mix old foreground modules with newly started workers. Plugin installation already has durable recovery for configuration, approvals and artifact promotion, but its process-local lock cannot serialize a separate installer process.

## Decision

The public `synergy-plugin/package` contract distinguishes components, process plugins, declarative presets and native applications. Component API1 metadata includes an entrypoint and host compatibility; application artifacts include checksums and platform signing identities. The outer metadata does not alter Plugin API4 or UI API6 and cannot confer plugin capabilities.

Plugin Host owns the installation generation ledger. It seals the complete staged module tree, rejects links outside the generation, requires explicit host-code trust, and verifies the tree before loading it. A durable intent records the previous and next activation pointers. Recovery removes an unpublished promotion or preserves a committed generation; a conflicting pointer stops recovery without discarding evidence. Old generations remain available to running processes and workers. Version floors survive component removal, so an older binary or reinstalled component cannot silently reopen data upgraded by a newer version.

API4 installation and generation activation share the same cross-process file lock. Both resolution paths disable package-manager lifecycle scripts, including default-trusted dependencies; plugin setup remains a permission-governed post-commit lifecycle contribution. API4 configuration, approval and catalog recovery retains its existing SQL owner. Shared atomic file writes and transient I/O retry primitives live in Util, so pre-bootstrap verification does not load Harness. Both installation paths use those primitives for durable promotion.

The dependency-light `installation/catalog` leaf owns first-party core/full/Web/Desktop package selections for the installer, source composition and release tooling. This prevents core installation from importing the full product assembly.

Package resolution reads `package.json` metadata and expands explicit preset/component selections in a staged Bun graph. Registry, Git and local package sources use the package manager with lifecycle scripts disabled; metadata inspection never imports the component entrypoint. Package-manager subprocesses use the shared Util process-group owner, so cancellation drains Git descendants before removing the stage. Package sources cannot be interpreted as package-manager flags. Failed resolution removes its stage. Additions retain explicit roots and the resolved lock, while removals rebuild from the retained lock to prune unused modules. Removing an indirect requirement reports its owners. Component loading rejects a second Harness copy before evaluating any factory and compares executable identities and requirements with approved metadata. A generation can be verified by its pinned digest after another installation becomes active.

## Alternatives considered

**Install modules into a running graph.** A new worker could resolve different code from its foreground owner.

**Treat host components as ordinary plugins.** In-process registration has different authority and cannot reuse a capability approval as permission to execute arbitrary host code.

**Move the plugin approval store into the bootstrap file.** The bootstrap needs only the selected module graph. Moving approvals would create a second migration and recovery owner without improving that boundary.

## Consequences

The installer records approved API4 activation actions inside the sealed generation. Activation keeps the existing SQL transaction owner and records idempotent completion; a failed action retains its journal and prevents a later generation from overtaking it. Recovery only applies the current generation, so a worker pinned to an older generation cannot restore older plugin code. Host-code trust and plugin grants remain separate decisions.

The CLI owns a dependency-light launcher, while component packages declare their special subprocess runners in package metadata. Workers return through the verified launcher before importing their modules. Generation directories use canonical paths so home aliases preserve module identity. Detached native supervisors receive explicit installation and data-home variables; a worker missing its parent pin cannot initialize another home. The launcher buffers bounded early IPC frames until the selected worker registers its receiver; asynchronous integrity verification must not drop SQLite initialization or policy requests. File inventory hashing uses Bun-owned streams so closing a Node FileHandle stream cannot invalidate subsequently reused subprocess descriptors. Application payloads are downloaded and platform-signature checked during preparation; a failed download or publisher check cannot produce a launchable selection. Portable signed app bundles permit installation without mutating an already running Desktop bundle.

Generic workspace archives contain JavaScript and types; target-specific resources have distinct native package identities selected through optional dependencies. This avoids publishing different CPU or OS contents under one package version. The npm launcher copies the installed core dependency closure into the first sealed generation without resolving it again over the network. Required peers, npm aliases and nested version conflicts retain their module identities; optional peers do not become active features.

Installation prepares a new generation and activation affects the next start. Integrity checking includes dependencies and native artifacts. Tests exercise explicit trust, stale-plan rejection, tampering, escaping links, host compatibility, interrupted publication and existing API4 recovery. The normal fresh-install and update command paths must use this owner rather than independently writing activation pointers.
