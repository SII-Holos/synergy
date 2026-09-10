# Decision Record: Unified read-only shell catalog ends autonomous external-write false positives

Status: implemented

## Problem

Autonomous sessions kept hard-denying benign read-only shell compounds as `file_external_write`. The reported shape: `ls <external-dir> && echo --- && ls <dir> | grep -i -E "meme|lingo"` — `echo` was missing from the 10-entry `SAFE_COMMANDS` name whitelist, so the compound classified as writable `shell`, and the gate's pipeline aggregation promoted every external path in the command to a non-bypassable external write. Earlier fixes (jq whitelist addition, cp operand roles, read-only `gh api`, `/dev/null` sink spellings, find/fd exec whitelist, slash-relative cd, worktree git reads) each repaired one shape, because the classifier carried fragmented name-only lists (10-entry `SAFE_COMMANDS` versus the ~50-entry find-exec `READ_ONLY_EXEC_TOOLS` in the same file) and a whole-text substring scan of `UNSAFE_SHELL_TOKENS` that matched quoted argument text. The structural debt guaranteed the next benign command would reopen the same denial class.

## Decision

Shell read-only classification rests on one closed-world catalog in `shell-safety.ts`: `READ_ONLY_COMMANDS` (the union of the two former lists, adding `echo` and `printf`) plus `READ_ONLY_ARG_BLOCKERS`, consulted through `isReadOnlyInvocation(name, args)` by both compound-segment classification (`isSafeSimpleCommand`) and find/fd `-exec`/`-execdir` inspection, so a utility trusted in one context cannot stay untrusted in the other. `sort -o`, `diff -o`/`--output`, and `file -C`/`--compile` are gated by flag-level patterns, keeping flag-driven writers out of the read-only class. The `UNSAFE_SHELL_TOKENS` scan runs over `literalMaskedShellText`, a single-pass state machine that blanks quoted string literals while keeping shell operators, backtick regions, and `$()` payloads visible; any unbalanced quote, backtick, or `$()` sequence fails closed by returning the unmasked text. The `printf ` token left the "Shell escape" token section because its destructive guarantees live in dedicated anchors (pipe-to-shell, heredoc bodies, sudo and stdin-fed payload detection, and the `. ` source token). Gate pipeline aggregation, profile policy, and sandbox behavior are unchanged.

## Alternatives considered

**Add `echo` to the whitelist only.** The minimal patch (the same shape as the earlier jq fix) repairs the reported command but leaves the wider deny class (`sort`/`uniq`/`cut`/`tr`/`stat`/`du`/`md5sum`/`diff`/`seq`/`printf` compounds) and the quoted-argument false-positive class, recreating the per-shape whack-a-mole cycle this change ends.

**Extract the catalog into a new module.** Both lists and both consumers already live in `shell-safety.ts` with no second consumer, so a module boundary adds import surface without protecting anything.

**Merge the `exec-policy.ts` `KNOWN_SAFE` list.** That list is the policy-layer allow/ask/deny heuristic with different semantics and entries (`env`, `find`, `which`); merging would cross the classification-versus-policy boundary that execution boundaries deliberately keeps separate.

**Weaken gate pipeline aggregation to per-segment path attribution.** The conservative aggregate is correct security posture; once per-segment risk is accurate, benign compounds classify `shell_read` and never enter the aggregate write path at all.

## Consequences

Benign read-only compounds with pipelines and external paths now run unattended under `autonomous` (still contained by the workspace-write sandbox wrapper), removing the recurring false-denial class. The classifier is stricter where it was silently loose: `find . -exec sort -o /etc/hosts {} \;` is destructive, `sort -o` and `diff -o` compounds classify writable, quoted `sudo`/`rm` text in arguments no longer flips benign commands writable, while `echo `rm x``and`echo "$(sudo x)"`stay writable because substitution regions remain visible to the token scan. The masking state machine is a new quoting-aware parsing surface that fails closed on anything it cannot parse. The documented`. ` token false positive on dot-containing filenames remains (conservative direction, out of scope).
