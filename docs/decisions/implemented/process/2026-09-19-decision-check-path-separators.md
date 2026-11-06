# Decision Record: Decision-record paths compare in forward slashes

Status: implemented

## Problem

The decision-record gate's archive-seal lookup and staged-file filter built repo-relative keys with the platform path separator. `archived/manifest.json` stores forward-slash keys and git prints forward slashes on every platform, so on Windows every sealed archived record reported as unsealed (and its manifest entry as unmatched), while `--staged` silently skipped decision records entirely. The pre-push gate therefore could not pass on Windows checkouts.

## Decision

Both comparisons normalize to forward slashes: the staged filter compares git output against a slash-joined repo-relative decisions directory, and archive-seal keys are slash-joined `path.relative` results. POSIX behavior is unchanged because the separator already was `/`.

## Alternatives considered

**Store backslash keys in the manifest on Windows.** The sealed artifact would become platform-dependent and existing manifests would stop verifying. Rejected.

**Normalize only inside the seal check.** Leaves the staged filter broken on Windows, where records would silently escape the format gate. Rejected.

## Consequences

The gate passes on Windows checkouts and `--staged` actually sees records there. The cost is one separator normalization at each comparison boundary; the manifest format and error labels are unchanged.
