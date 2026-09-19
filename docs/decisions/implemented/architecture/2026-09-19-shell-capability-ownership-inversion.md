# Decision Record: One execution-time owner per capability class for shell filesystem reach

Status: implemented

## Problem

Capability classification had two layers deciding the same question. Structured tools passed literal path arguments that the policy layer resolved against the workspace and approved roots, and the enforcement gate independently predicted the filesystem reach of a bash command string by parsing its text: `extractAbsolutePaths`, `extractShellPathArguments`, `writeRedirectTargets`, `maskHeredocBodies`, `isNullDeviceSink`, `resolveCopyOperands`, and the copy-operand role tables, plus an eleven-function directory-change analyzer and a compound shell-state dependency walker in `shell-safety.ts`.

A shell command string is not a precise input. Every one of those extractors answered from argument text what the operating system would later answer from the real syscall, and each answer was a separate opportunity to be wrong. The machine accumulated five documented false-positive decision records (`2026-08-20-copy-operand-role-classification`, `2026-09-03-null-device-sink-write-redirect-classification`, `2026-09-05-autonomous-bash-exec-precision`, `2026-09-10-unified-read-only-shell-catalog`) and roughly two thirds of the classifier's code, and it never converged: each repair added a shape the next spelling escaped. The read-only catalog compounded this by giving bash a `shell_read` tier — a low-risk capability whose entire content was a claim about utilities the gate could not actually observe.

The gate's own consumers paid for the ambiguity. `classifyPathCapability` had nineteen call sites and `aggregateWriteCapable` six, and bash minted `file_write` and `file_external_read` capabilities from predicted text that the sandbox would decide differently.

## Decision

Each capability class has exactly one execution-time owner, and neither layer predicts the other's answer.

- **Precise input belongs to the policy layer.** A structured tool's literal path argument (`write`, `edit`, `read`, `view_file`, `scan_files`, and their peers) is resolved against the workspace and approved roots by `classifyPathCapability` / `classifyProtectedPathCapability`, exactly as before. These functions survive; only their bash-branch callers were removed.
- **Imprecise input belongs to the execution layer.** bash is this repository's only imprecise input, so it contributes only the capabilities the OS sandbox cannot express: `shell`, `shell_branch_mutation`, `shell_remote_publish`, `shell_remote_write`, `shell_destructive`, `shell_hardline`, plus `network_request` and `shell_remote_execute`. The gate's bash branch mints no `file_*` capability at all — not for `workdir`, not for redirect targets, not for absolute paths, and not for directory changes.
- **bash loses its path-prediction machine.** `gate.ts` drops `extractAbsolutePaths`, `extractShellPathArguments`, `writeRedirectTargets`, `maskHeredocBodies`, `isNullDeviceSink`, `SAFE_PSEUDO_PATHS`, `NON_PATH_PATTERNS`, the copy-operand role tables and their parser, `shellTokenize`, and the whole bash-branch block that consumed them (`aggregateWriteCapable`, the per-segment loop, and the `args.workdir` prediction). `shell-safety.ts` drops the directory-change analyzer and its thirteen helpers, `analyzeDirectoryChanges`, `hasCompoundShellStateDependency`, `analyzeDirectoryCommandParts`, the recursive walker, `unquotedShellText`, `hasReparsedLastArgumentReference` and its last-argument helpers, and the escaped-ANSI-C quote detectors.
- **The read-only catalog is gone, and with it `shell_read`.** `READ_ONLY_COMMANDS`, `READ_ONLY_ARG_BLOCKERS`, `READ_ONLY_LONG_ARG_BLOCKERS`, `isReadOnlyInvocation`, `isSafeSimpleCommand`, `UNSAFE_SHELL_TOKENS`, `stripAllowedRedirects`, `ShellSafety.isReadOnly`, and `ShellSafety.capability` are deleted, along with the `findFdExecTextUnsafe` branch of `hasUnsafeExecTarget`. `find -delete`, `find -exec`, and in-workspace subtree removal (`rm -rf node_modules`, `rm -r ./build`, `rm -f ./tmp.log`) are now sandbox-owned: allowed under `autonomous` inside the workspace and refused by the operating system outside it. `shell_read` is removed from `SYNERGY_CAPABILITY_DETAILS`, `SYNERGY_PROFILE_CAPABILITIES`, `BashRisk`, `tool-resolver.ts`, and the bash tool's ask metadata; with no precise input to reason about, a read-only tier could only ever restate a guess about argument text.
- **The sandbox-inexpressible detectors keep their full reach.** Privilege escalation (`hasSudoInvocation` and the `sudo` / `runuser` / `pkexec` / `nsenter` / container / `script` option tables), the fd/heredoc/stdin replay chain, irreversible local-history loss, and remote mutation are untouched. They are exactly the capabilities the sandbox cannot express, and `classifyBashRisk` still reaches `ShellSafety.hasSudoInvocation` through `hasSudoInvocationRecursive`.

## Alternatives considered

**Keep the prediction machine and repair the remaining false positives one spelling at a time.** This is what the five prior decision records did. It failed on its own evidence: each fix moved the boundary and the next benign command reopened the class. The machine's cost was also structural — nineteen call sites for one primitive, and a compound analyzer whose results the gate could not verify against execution.

**Keep `shell_read` as a reporting-only tier with no enforcement effect.** A tier that changes no decision is dead weight, and it would still be populated from argument text. Under the inversion there is nothing precise to reason about, so the honest floor for a shell command is `shell`. Removing it also removed a `file_*`-adjacent concept that invited callers to treat predicted reads as observed ones.

**Delegate the whole bash filesystem question to the sandbox and stop classifying shell risk entirely.** Rejected: the sandbox cannot express host-level destruction, privilege escalation, or remote mutation. Dropping those would delete real boundaries to remove an unrelated one.

**Add a per-shape whitelist for the filesystem shapes that were previously refused** (`find -delete`, in-workspace `rm`). That is the same false-positive treadmill in reverse, and it would reintroduce command-text prediction through the back door.

## Consequences

The two accepted costs are deliberate:

- **Partial side effects.** A command that mixes a sandbox-inexpressible boundary with a filesystem effect can now perform the filesystem part before the boundary is refused at execution time. The gate decides from the command string and the sandbox decides from the syscall, and a compound command can reach both. The trade is accepted because the alternative is predicting filesystem reach from text, which is the defect this record removes.
- **Network-detection precision change.** `bash -c '…'`-style payloads that previously surfaced as `network_request` through the removed command-name catalog no longer do so for every spelling. `commandReachesNetwork` and its closed sets are unchanged, so the detection that remains is the operation-resolved one; the change is in coverage, not in mechanism.

The accepted residual false positives are the B-class cases: a command whose only reach is the filesystem is never refused by the gate, so a genuinely unwanted in-workspace deletion now depends on the sandbox rather than on policy. This is the intended ownership boundary, and it is pinned by `packages/harness/test/enforcement/ownership-inversion.test.ts`.

What the change bought: 565 lines removed from `gate.ts` (1672 → 1107) and 804 from `shell-safety.ts` (3996 → 3192), one execution-time owner per capability class, no prediction-plus-sandbox dual decision, no compatibility shim, and a capability table without a tier that could not be observed. The sandbox became the single owner of bash filesystem containment, which is the layer that can actually see the operation.

Restructuring note: `envDirectoryChange` was reduced to `envWrappedCommandIndex`, since six of its seven callers needed only the wrapped-command index (its target and opacity outputs served the deleted analyzer). `remoteCommandPayload` survives because its only caller is `hasSudoCommandParts` — the privilege-escalation chain for `ssh` / `mosh` payloads. `dynamicDirectoryTarget` was removed with the analyzer; the surviving callers use the narrowed helper.
