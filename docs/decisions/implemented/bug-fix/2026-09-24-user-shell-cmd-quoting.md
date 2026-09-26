# Decision Record: Preserve quoted Windows user shell commands

Status: implemented

## Problem

The user shell passed a command directly to `cmd /c`. A command containing both a quoted executable and a quoted script path could lose its enclosing quotes before execution. The native descendant-ownership regression then waited for a child that never started. The Bash tool already handled this command boundary correctly, but the user shell had a separate invocation table.

## Decision

The user shell invokes `cmd` with `/d /s /c` and an additional quote pair around the complete command, matching the Bash backend. The owned native worker retains its existing verbatim-argument path for `cmd`. Inner executable and argument quoting survives the interpreter's removal of the outer pair, and registry AutoRun commands cannot change this explicit invocation.

Provenance: [Microsoft cmd command and quotation rules](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd). Local adaptation: apply the documented outer-quote handling at the user shell boundary while preserving the existing native process owner and command text.

## Alternatives considered

**Select Git Bash in CI.** That would hide the supported `cmd` path and leave quoted user commands broken whenever the default resolves to `cmd`.

**Increase the descendant startup timeout.** The process exits before starting its descendant; waiting longer cannot repair command parsing. The fixture now reports early completion output and the selected shell instead of hiding that result behind a marker timeout.

## Consequences

Windows coverage explicitly selects `cmd` and checks quoted executable and script paths, spaces, Unicode, empty arguments and shell metacharacters. The existing percent-loop and detached-descendant tests retain their original assertions. Other shell invocation rules and native ownership remain unchanged.
