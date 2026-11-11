# Decision Record: Publish immutable organization knowledge and artifacts

Status: implemented

## Problem

Sharing a mutable member directory would expose private files and make a cited Skill or project output change after use. Published outputs also need a lifecycle independent of their source Session.

## Decision

Keep explicit organization and project publications in the organization service's isolated Storage namespace. Upload declarations, bounded immutable chunks and a sealed content manifest precede publication. Use canonical Storage prepared binaries, publishing their metadata only after preparation and retaining authorization inside metadata transactions. A failed validation never publishes a version. Request identities reconcile retries and reject changed inputs.

Knowledge items publish immutable, checksum-pinned material or Skill versions. Parse Skills through the existing ConfigMarkdown and SkillManifest contracts. Search traverses textual bytes in bounded UTF-8 slices, authorizing before each slice and before returning a match; it does not require whole-file buffering or impose a lifetime file-size quota. A complete member applied manifest and each hosted Session's independent selected manifest use revision comparison and atomic replacement. A new publication does not silently update existing selections. Signed machine knowledge requests reuse accepted execution grants and require an exact selected version, current actor and current Session binding.

Publication paths reject portable filesystem aliases and file/directory ancestry conflicts. A domain migration indexes existing directory declarations without rewriting immutable contents. New releases retain a minimal publisher name snapshot so removing or renaming an account cannot rewrite provenance; historical releases without a snapshot retain their original account ID.

Project artifacts publish independent immutable versions. Authorization follows the publication's project, while source links are returned only when the reader can currently see the source Session. Source deletion, unsharing or loss of source visibility does not delete published bytes. Downloads authorize every bounded read and support authenticated HTTP Range requests; references contain hashes and identities rather than permanent download credentials.

## Alternatives considered

**Share member directories directly.** Mutable files cannot preserve published versions and may contain private state.

**Reuse shared transcript blob generations as publication ownership.** Unsharing a Session would incorrectly remove independently published project outputs.

**Create a second Library or Skill parser.** Publication is an organization distribution lifecycle; parsing and execution remain with their existing owners.

## Consequences

Published bytes have an independent lifetime and may outlive a Session. Version selection remains explicit and attributed. Chunk and page limits bound individual operations without imposing an object-count or lifetime task quota. Runtime cache staging, application and model-facing knowledge access compose this service contract separately.
