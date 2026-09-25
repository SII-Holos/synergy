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

Launcher upgrades replace the core generation and preserve the user's explicit selection. Version-aligned first-party roots follow the host; third-party and local pins retain their identity and compatibility checks. An upgrade reuses reviewed API4 grants only when its manifest remains identical. Interrupted activation can resume with the previous core before upgrading. The versioned initial-selection owner runs before Harness imports and also participates in central migration tracking, so adoption of an existing data home preserves its full Web backend without recursively installing Desktop.

Pure component installation avoids database ownership; plugin activation still uses the existing exclusive transaction workflow. Source composition cannot accidentally publish an incomplete installed generation. Package identity and special-runner collisions fail before activation, local artifact replacement handles equal-version changes, and native application updates retain signing continuity and reuse verified unchanged payloads.

The installer records approved API4 activation actions inside the sealed generation. Activation keeps the existing SQL transaction owner and records idempotent completion; a failed action retains its journal and prevents a later generation from overtaking it. Recovery only applies the current generation, so a worker pinned to an older generation cannot restore older plugin code. Host-code trust and plugin grants remain separate decisions.

The CLI owns a dependency-light launcher, while component packages declare their special subprocess runners in package metadata. Workers return through the verified launcher before importing their modules. Generation directories use canonical paths so home aliases preserve module identity. Detached native supervisors receive explicit installation and data-home variables; a worker missing its parent pin cannot initialize another home. The launcher buffers bounded early IPC frames until the selected worker registers its receiver; asynchronous integrity verification must not drop SQLite initialization or policy requests. File inventory hashing uses Bun-owned streams so closing a Node FileHandle stream cannot invalidate subsequently reused subprocess descriptors. Application payloads are downloaded and platform-signature checked during preparation; a failed download or publisher check cannot produce a launchable selection. Portable signed app bundles permit installation without mutating an already running Desktop bundle.

Generic workspace archives contain JavaScript and types; target-specific resources have distinct native package identities selected through optional dependencies. This avoids publishing different CPU or OS contents under one package version. The npm launcher copies the installed core dependency closure into the first sealed generation without resolving it again over the network. Required peers, npm aliases and nested version conflicts retain their module identities; optional peers do not become active features.

Installation prepares a new generation and activation affects the next start. Integrity checking includes dependencies and native artifacts. Tests exercise explicit trust, stale-plan rejection, tampering, escaping links, host compatibility, interrupted publication and existing API4 recovery. The normal fresh-install and update command paths must use this owner rather than independently writing activation pointers.

Compiled releases use the same CLI launcher and package graph as npm installations. The offline seed contains an explicit core or Web selection; Desktop keeps the Web selection and adds its native shell outside that seed. Optional module resources remain with their owners. Release and Desktop share one required-path contract; the shell installer consumes its sealed inventory. Every module file is checksum-covered, including license filenames containing spaces. Upgrade backup and restoration move the launcher and module seed together, while older workers retain their pinned generation.

The release catalog now publishes the entire workspace dependency closure and native target family. Publication uses the same archives as package validation and does not change sealed file modes or leave tarballs inside runtime payloads. Desktop application metadata is a small npm package referencing verified portable assets from the same release; native jobs record signing identity and hashes before publication. Windows preserves its existing signing-continuity policy with an explicit checksum-only declaration for an unsigned distribution. Independently versioned Plugin Kit reads its declared host requirement so its package version does not imply a nonexistent host release.

Explicit package removal and interrupted activation use the active core before attempting an upgrade. This gives incompatible third-party selections a recovery path while keeping ordinary launches strict. Internal runner dispatch uses the command position so a user prompt cannot accidentally select a subprocess role.

Application ZIP extraction is verified after bundling. The thin launcher excludes unzipper’s unused optional S3 adapter dependency while retaining local archive extraction; a real packaged ZIP regression covers that boundary.

Containerized native builds use the invoking user identity and a writable container Cargo cache. Build staging and cleanup must remain owned by the caller on Linux, including musl builds.
