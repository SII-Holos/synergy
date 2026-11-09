# Decision Record: Normalize source permissions in build identity

Status: implemented

## Problem

The dependency installation step can add group and other write bits to an executable source file. Shared build production runs after that installation, while consumers restore the bundle before installing dependencies. The source bytes and executable intent are identical, but the raw mode differs and rejects the valid bundle.

## Decision

Source identity clears group and other write bits before hashing file modes. It retains owner permissions, read and execute bits, symlink targets and file bytes. Published build outputs keep their exact mode in the output manifest, so restoration still rejects a changed artifact mode. A regression changes the fixture executable from 0755 to 0777 and requires the source identity to remain stable.

## Alternatives considered

**Move dependency installation before shared-build restore.** Rejected because restore is intentionally the first consumer step and should validate the producer's verified outputs before any workspace setup.

**Ignore executable modes entirely.** Rejected because executable intent remains part of the build contract; only package-manager-added group and other write bits are unstable.

**Special-case the CLI launcher path.** Rejected because the same installation mutation can affect another executable source in a future workspace. Normalizing the unstable permission bits keeps the rule general without excluding source content.

## Consequences

Producer and consumer identities agree across the restore/setup boundary while source bytes, owner permissions, read permissions and executable bits remain covered. A deliberate group or other write-bit change no longer invalidates a build identity; output publication and restoration continue to use exact modes for generated artifacts.
