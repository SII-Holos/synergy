# Decision Record: Isolate Windows application signature inspection

Status: implemented

## Problem

Windows PowerShell signature inspection can inherit PowerShell 7 module search paths through a Bun intermediary. The incompatible system modules prevent signature commands from loading. A nonterminating PowerShell error can then produce an empty signature status with a successful process exit, and JSON parsing can conceal the original failure. Desktop release receipts and installed application verification independently execute the same inspection.

## Decision

Plugin Host owns one Windows signature inspector shared by installed application verification and Desktop receipt generation. The Windows PowerShell child removes inherited `PSModulePath` case-insensitively without modifying its parent environment. Inspection uses terminating command errors, checks process failure before decoding JSON, retains native diagnostics and rejects empty statuses. Publisher equality and signed-update continuity remain required; only a confirmed `NotSigned` result can qualify for the existing unsigned release policy.

The environment handling follows [Microsoft's description of Windows PowerShell launched through an intermediate process](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7), cited beside the owning implementation. Windows CI requires a real native scenario with PowerShell 7 module paths, signed system code, an unsigned fixture, wrong-publisher rejection and missing-file rejection. Non-Windows skips cannot satisfy that scenario.

## Alternatives considered

**Treat an empty signature status as unsigned.** This would confuse a broken inspector with an unsigned executable and conceal signature validation failures.

**Change only the release shell environment.** Installed application verification can encounter the same inherited environment, and duplicated inspectors would continue to diverge.

**Require PowerShell 7 for application installation.** Signature verification can use the Windows-provided PowerShell without adding a new runtime prerequisite.

## Consequences

Release receipts and application installation use the same native inspection semantics. A caller's custom module path does not affect this system operation, while other child environment values remain intact. The native CI scenario adds bounded subprocess work; packaging, publisher continuity and released-upgrade acceptance remain separate gates.
