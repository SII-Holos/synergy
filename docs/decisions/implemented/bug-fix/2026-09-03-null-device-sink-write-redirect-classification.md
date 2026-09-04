# Decision Record: Null-device sink and write-redirect classification in the bash enforcement gate

Status: implemented

## Problem

The enforcement gate's bash path extractor treated a null-device sink glued to closing shell punctuation as an external filesystem path. The absolute-path regex consumed `2>/dev/null)` as the candidate `/dev/null)` because its character class did not terminate at `)` or `}`; the candidate missed the exact `SAFE_PSEUDO_PATHS` set (`/dev/null` only), and inside a write-capable compound command (a `for` loop with command substitutions, `$(git … 2>/dev/null)`) the segment classified as write-capable, so `classifyPathCapability(write: true)` minted a non-bypassable `file_external_write`. Under the `autonomous` profile — which denies `file_external_write` with no SmartAllow path — a benign read-only repo-scan script (`out=/tmp/des-reposcan.txt` plus git reads with `2>/dev/null` sinks) was hard-denied. The same defect class surfaced on read-only compound commands whose only "write sign" was an empty sink, and an inverse defect let a genuine write-redirect target on an otherwise read-only command classify as a read: `git status > /tmp/out` produced `file_external_read` (bypassable, allowed in autonomous) even though the redirect writes an external file.

## Decision

The gate's bash classification now treats null-device sinks as non-paths and write-redirect targets as genuine writes, independent of the surrounding segment's read risk.

- `extractAbsolutePaths` terminates a path candidate at closing shell punctuation (`)`, `}`) and normalizes any trailing closing punctuation before the safe-path set comparison, so `2>/dev/null)` resolves to the safe sink `/dev/null` instead of the pseudo path `/dev/null)`.
- A `NULL_DEVICE_SINK` matcher covers `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, and `/dev/fd/N` (with or without a glued closing paren/brace). Sink candidates are dropped from the per-segment path stream and from `extractShellPathArguments` operand parsing (a `tee out 2>/dev/null` redirect target is not a `tee` operand).
- `stripAllowedRedirects` in `shell-safety.ts` recognizes stdout, stderr, and combined null-device sink spellings (`>`, `1>`, `2>`, `&>`, `>>`, optional whitespace, glued `)`/`}`) so `isReadOnly`/`classifyRisk` are not misled by an empty sink.
- A new `writeRedirectTargets` extractor finds statically resolvable write-redirect targets (`>`, `>>`, `>|`, `&>`, `&>>`, `N>`, `<>`) in each segment; those targets classify with write semantics even when the segment itself is read-only. Heredoc/herestring and `<`-family input redirects, fd duplication (`2>&1`, `<&1`), fd closing (`3>&-`), dynamic targets (`$var`, backtick), and null-device sinks are excluded. Relative targets resolve against the effective Bash working directory.
- Dynamic `cd` into an un-resolvable target inside a compound (`for d in */; do (cd "$d" && …)`) keeps the conservative opaque `file_external_write` deny: a variable directory target can escape the workspace and cannot be resolved statically. This boundary is unchanged and is asserted by the regression tests.

## Alternatives considered

**Extend `SAFE_PSEUDO_PATHS` to prefix-match `/dev/null`.** Rejected: an exact closed set plus candidate normalization is tighter than a prefix rule, and a prefix rule could mask genuine writes under `/dev/…` beyond the sink family (raw devices stay guarded by destructive/hardline rules).

**Reuse the existing `shellRedirect`/`shellRedirects` parser instead of a new `writeRedirectTargets` walker.** The existing parser understands redirect shape but is oriented to stdin/fd data-flow and lives in `shell-safety.ts`; the gate needs an independent, statically resolvable write-target stream for its path classifier. The new walker deliberately skips fd duplication/closing and dynamic targets so classification stays conservative without a second trust boundary.

**Mask sinks before `analyzeDirectoryChanges`/`hasCompoundShellStateDependency` to narrow the opaque aggregate write.** Rejected in this change: the opaque aggregate only fires when a compound is write-capable AND has an un-resolvable directory change or shell-state reuse — forms that genuinely can escape the workspace. Masking there would weaken real external-write detection. The regression suite pins the conservative boundary instead.

**Full shell AST/tokenizer rewrite of the path extractor.** Rejected: the gate owns a static, budget-bounded classifier; a general parser would be a new trust boundary. The closed repairs above cover the reported false-positive family without restructuring.

## Consequences

Benign read-only compound shell under `autonomous` — the repo-scan script and its `/dev/null`-sink spelling family — is no longer hard-denied as an external write; the null sink never surfaces an external path capability. Genuine external writes stay denied: `cp a /etc/x`, `mv` across the boundary, `dd of=/dev/sda`, protected paths, and dynamic-`cd` compounds are unchanged. The inverse hole is closed: `git status > /tmp/out` now classifies `/tmp/out` as an external write (denied under `autonomous`) instead of a bypassable external read that would actually write the host file. Cost: one bounded redirect-target walker and two small matcher/terminator changes in the gate; conservative fallbacks for anything not statically resolvable remain intact. `docs/architecture/execution-boundaries.md` was updated to state the sink and write-redirect classification rules.
