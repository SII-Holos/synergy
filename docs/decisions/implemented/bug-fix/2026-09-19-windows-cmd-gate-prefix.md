# Decision Record: Windows cmd gate prefix is parser-safe and spawned verbatim

Status: implemented

## Problem

Every Bash-tool command on Windows that runs outside the OS sandbox is gated by a `WindowsProcessJob` command-line prefix: the shell waits for a gate file that is written only after the kill-on-close Job Object owns the process. On machines whose selected shell is `cmd.exe` (no `$SHELL`, no Git Bash), every command exited with code 1 within milliseconds, produced no output, and never ran the user command — the tool reported an empty, successful result. The failure was silent and mode-independent in mechanism, but it defined the full-access and guarded-without-sandbox-helper experience on such machines, where every shell invocation is gated.

The prefix had two independent defects:

1. In cmd, an unparenthesized `for /l ... do` body owns the entire remaining `&` chain, so the `if not exist ... exit /b 1` guard ran inside every loop iteration. The designed bounded poll (200 attempts, ~2s) collapsed to "exit on the first miss."
2. The prefix contained plain `"` characters. cmd children were spawned through libuv's default argument quoting, which escapes them as `\"` per `CommandLineToArgvW` rules. cmd.exe does not follow those rules: the backslash stays literal and the quote flips the parser's quoting state, corrupting every `if exist` operand (the gate path acquired a leading `\` and never matched). PowerShell and Git Bash were unaffected because they consume argv like `CommandLineToArgvW` or do not see the corrupted quoting the same way.

## Decision

The cmd gate prefix is restructured so each phase is its own parenthesized chain element: `( for /l poll loop ) & ( fail-closed check: stderr hint + exit /b 1 ) & del gate`. The loop body contains only the poll; the bail-out runs once, after the loop, so the bounded-poll window actually exists.

`WindowsProcessJob.prepare` now reports `verbatimCommandLine` for cmd shells, and the Bash backend passes it to `spawn` as `windowsVerbatimArguments`. The prefix's plain quotes therefore reach cmd.exe unchanged, and the `%SYNERGY_WINDOWS_JOB_GATE%` expansion keeps spaces intact. PowerShell and bash prefixes, and their quoting, are unchanged.

The behavioral contract is covered by real-spawn tests on win32: a gated command runs exactly once and its exit code propagates when the gate opens; when the gate never appears, the command fails closed, never runs, and the stderr hint mentions the gate.

## Alternatives considered

**Move the command into a generated batch file.** A `.cmd` file avoids the command-line quoting problem entirely, but it changes parsing semantics the design deliberately preserves: `/c` command lines use single `%` loop variables while batch files require `%%`, and a temp-file lifecycle would need cleanup on every failure path. Rejected.

**Escape the quotes with cmd carets (`^"`) instead of verbatim spawning.** Caret escaping survives libuv's transformation, but caret processing interacts with cmd's parse phases and with the surrounding parentheses and `if` blocks; a first measurement battery showed the caret variant still failing the gate check. Verbatim spawning restores plain-quote semantics directly and keeps the prefix readable. Rejected.

**Drop the gate for cmd and spawn without Job containment.** This would remove the whole mechanism's purpose: a user command could spawn descendants (for example `cmd /c start`) before the kill-on-close job owns the process tree. Rejected.

**Fix only the loop structure and keep the old quoting.** The first battery case (gate pre-created, old prefix) proved the quoting defect alone keeps the happy path broken: the gate never matched, so the command still exited 1 without running. Both defects had to be fixed together.

## Consequences

The fix buys back the gate's actual guarantee on cmd machines: containment is established before the user command can run, and commands execute normally (~30ms prefix overhead when the gate is already open). The cost is a cmd-specific spawn option threaded through `Prepared` — callers spawning a prepared job must honor `verbatimCommandLine`, or cmd quoting silently breaks again — and a worst-case ~1.5s bounded wait before fail-closed when the job runtime never activates, now with a stderr hint instead of silence. The `%cmdcmdline%`-style echo of a command's own command line remains a pathological special case, not a supported pattern.
