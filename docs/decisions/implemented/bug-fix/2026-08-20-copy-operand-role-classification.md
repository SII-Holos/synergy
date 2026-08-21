# Decision Record: Copy-command operand role classification in the enforcement gate

Status: implemented

## Problem

The enforcement gate classified every path argument of a write-capable shell segment as a write target. `cp`, `install`, and `ln` only write their final positional operand (or the `-t`/`--target-directory` value); every other operand is a read-only source. The blanket rule made "import an external file into the workspace" — a read-external, write-inside operation with no external mutation — surface a non-bypassable `file_external_write` capability. Under the `autonomous` profile, which denies `file_external_write`, plain `cp ~/.cache/models.json ./cache/` was hard-denied with no SmartAllow path, even though the only write landed inside the workspace. The same defect inverted `ln -s`: the read-only link target was classified as a write while the actual created symlink was the sole write.

## Decision

The gate's bash path-argument loop now resolves operand roles for plain `cp`/`install`/`ln` segments. A static parser (`resolveCopyOperands` in `packages/synergy/src/enforcement/gate.ts`) quote-aware tokenizes the segment (`shellTokenize`): it preserves quoted operands as single tokens, rejects any expansion (`$`, backtick), glob, redirection, or comment syntax up front, and resolves positional operands against the effective Bash working directory. Flag parsing recognizes GNU/BSD long and short flags as boolean, value-taking, or optional-value (including attached values such as `install -m 0755` and `cp -S.bak`), and stops at `--`. The final positional operand — or the `-t`/`--target-directory` value — classifies as the write target and is classified explicitly even when the generic path extractors skip flag values; every other operand classifies as a read, including sensitive-path read checks. Identical source and destination strings keep the destination's write role. `mv` keeps all-write classification because it deletes its source operands, and hard-link creation (`ln` without `-s`/`--symbolic`, `cp -l`/`--link`) keeps the conservative all-write classification because a hard link mutates the source inode's link count and lets later writes pierce the external file. The role resolution applies only when the segment is a plain, statically resolvable copy command: pipelines, directory changes, shell-state reuse, wrappers, command substitution, globs in any operand, quoted or escaped operands, redirections, and any unrecognized flag abort back to the conservative all-write classification that shipped before.

## Alternatives considered

**Allow `file_external_write` for copy sources under `autonomous` via profile carve-outs.** Rejected: it weakens the external-write boundary for every command shape to fix one command family, and non-bypassable capability semantics forbid profile-level bypass anyway.

**Classify read-only utilities' paths as reads keyed off `classifyBashRisk`.** Already shipped for `cat`/`file`; rejected here because `cp` is genuinely write-capable — only its operand structure distinguishes source from destination, so the fix must be operand-level, not risk-level.

**Full shell parsing (AST) of every command.** Rejected: the gate owns a static, budget-bounded classifier; a general parser would be a new trust boundary. The token walker resolves only the closed `cp`/`install`/`ln` grammar and returns undefined for everything else, preserving the conservative fallback.

## Consequences

Importing external files into the workspace with plain `cp` (including chained `&&` segments, recursive flags, and `-t` targets) is now allowed under `autonomous` when the source is readable, while copying out to an external destination, `mv` across the boundary, credential sources (still surfacing `secrets`), and any dynamic or pipelined spelling keep the previous hard denial. The fix cost a token-level parser with a closed flag vocabulary: unrecognized copy flags (`cp --new-flag src dst`) fall back to all-write classification until the vocabulary is extended, which is the same conservative posture as before the change. `ln -s target link` now reports the symlink operand as the write and the target as an external read, correcting the inverted pre-change test expectation.
