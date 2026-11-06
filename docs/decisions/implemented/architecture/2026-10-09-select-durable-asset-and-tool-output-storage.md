# Decision Record: Select durable asset and tool output storage

Status: implemented

## Problem

Attachment references and truncated tool output can outlive the Host that created their files. A PostgreSQL session record containing a local path does not make those bytes recoverable. Reading an old cache after remote failure also hides missing authority.

## Decision

Runtime composition selects asset and tool-output persistence. `storedAssets` publishes binary references and full-checksum metadata in one transaction. Public asset identifiers retain their existing shape, and a different full checksum cannot overwrite the same short identifier. Asset reads obtain authoritative bytes before recreating private local cache files. Managed input preparation, rollout capture/restoration and HTTP asset reads use that path. Invalid IDs cannot become filesystem reads.

Truncated output calls its registered persistence adapter before returning a durable reference and the adapter's read instructions. Failure to store the complete output is an error, so the model never receives a fabricated recovery reference. Local applications continue to use the existing file-backed mode by default. Remote applications own a reader for the reference format they advertise.

## Alternatives considered

**Preserve old Host paths.** They remain unavailable after Host loss and do not define authorization on a replacement.

**Always trust a cache hit.** This treats an unverified disposable copy as authority after the backing record or object is unavailable.

## Consequences

Historical assets require offline import into the selected authority. Local extraction can materialize verified bytes into a disposable cache without making that cache a recovery dependency. Tool-output registration does not grant filesystem access or create an execution environment. The [asset contract](../../../../packages/harness/test/asset/persistence.test.ts) verifies new-Host recovery and model bytes; the [output contract](../../../../packages/harness/test/tool/truncation-persistence.test.ts) verifies persistence-before-reference and failure propagation.
