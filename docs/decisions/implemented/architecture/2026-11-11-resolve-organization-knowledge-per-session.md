# Decision Record: Resolve organization knowledge per Session

Status: implemented

## Problem

Two hosted Sessions can select different versions of the same Skill while sharing one Scope and Runtime. A Scope-wide Skill reload would replace another Session's selection, and automatic personal filesystem discovery would cross the organization boundary.

## Decision

Extend the existing instruction catalog query with an optional Session ID and forward it from the canonical Skill tool. Organization sources resolve the current Session's explicitly selected immutable versions through accepted execution proofs. Each paged or chunked request obtains a fresh proof and rechecks current service authority. The existing Cortex lineage determines the admitted source Session without granting sibling access.

Stage release files in a private temporary directory, verify relative paths, ranges, checksums, the ordered manifest and canonical Skill format, then rename the release and atomically replace the Session's complete active manifest after a final selection check. Failed downloads, stale revisions and edited caches preserve the prior manifest and user bytes. Cache identities include organization, project, item, version and manifest hash.

Reuse the existing Skill parser, resolver, collision diagnostics, renderer and reference loader. An explicit Skill snapshot accepts host-authorized roots and ranked contributions without resetting Scope caches. Members discover only this member Home's config roots and the explicitly selected project roots; ancestor, personal-global and sibling roots are excluded. Hosted Sessions use selected published Skills only. Local project Skills take precedence over project publications; member config follows project publications and precedes organization publications, with canonical shadow diagnostics.

At each model boundary, contribute the current version catalog and source guidance through the existing Session context owner. `organization_knowledge` exposes bounded list, file, read and content-search operations for selected versions. Reads record exact version/hash/range evidence and retain pagination. Content and Skill-reference loads revalidate selection and current authority before returning cached bytes. The tool is a resident read-only service capability, independent of a Workspace.

## Alternatives considered

**Reload the Scope's global Skill catalog.** This would couple unrelated Session selections.

**Add another Skill parser or Library.** Duplicate normalization and reference rules would diverge from existing local execution.

**Use a Runtime-wide latest release.** This would silently change hosted Sessions and invalidate historical references.

## Consequences

Simultaneous Sessions retain independent selected versions and historical observations. Network or authorization failures stop new knowledge reads while leaving the previous complete cache recoverable. Explicit staging and checksum checks add I/O at update and load boundaries, in exchange for verified atomic application and conflict preservation.
