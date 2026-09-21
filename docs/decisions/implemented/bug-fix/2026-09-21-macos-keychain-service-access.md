# Decision Record: Permit native macOS Keychain service access in the sandbox

Status: implemented

## Problem

Authorized GitHub CLI commands can fail authentication inside the macOS sandbox despite a working host login. The CLI's Keychain path uses `com.apple.SecurityServer`, which is absent from the default Mach service allowlist even though `com.apple.securityd` is present. Readable CLI configuration and the optional managed `GH_TOKEN` injection do not provide access to that service when the CLI owns the login.

## Decision

Add the exact `com.apple.SecurityServer` service to the shared macOS platform defaults. Native credential-service access is available in `workspace_write` and `read_only`, with either full or restricted networking. Keep command authorization, the environment allowlist, managed token injection, filesystem read denies, writable roots, and network policy unchanged. This supersedes the Keychain-unreachable statement in the [macOS read-denylist decision](../simplification/2026-09-14-macos-sandbox-read-denylist.md), without changing its filesystem policy.

The supporting experiment held the generated profile, command, and environment constant: host CLI authentication succeeded, sandboxed authentication failed with a kernel `mach-lookup com.apple.SecurityServer` denial, and adding only that service restored authentication. Token output was discarded. The behavioral regression uses a native `bootstrap_look_up` probe through the production wrapper, with a successful host baseline and all four filesystem/network combinations. It queries only a service port and never opens a Keychain item; synthetic file fixtures verify that credential reads and external writes remain denied and workspace writes follow the selected mode.

Apple's [Keychain access-control documentation](https://developer.apple.com/documentation/security/access-control-lists) describes item-level authorization for file-based Keychains. Synergy permits communication with that service and leaves its authorization intact; the sandbox does not impersonate a credential broker or narrow the service to a particular tool or account.

## Alternatives considered

**Require every CLI login to be imported into Synergy.** Managed token injection remains useful, but making it mandatory breaks existing native logins and requires a separate integration for each CLI's credential format.

**Bypass the sandbox for GitHub CLI or autonomous commands.** Authentication would work, but the process would lose filesystem containment for commands and subprocesses.

**Allow all Mach services or writable Keychain directories.** The observed failure requires one exact service lookup. Broad IPC access or filesystem write grants would expand unrelated permissions without evidence that they are needed.

## Consequences

Sandboxed CLI processes can authenticate using existing native Keychain entries when macOS permits the access. This grant applies to every sandboxed process, not only GitHub CLI. Keychain RPC operations can read or modify items independently of the caller's filesystem restrictions; `read_only` describes filesystem access and does not make the Keychain service read-only. Locked stores, item access controls, missing logins, and invalid credentials remain ordinary runtime failures or OS-mediated interactions. Synergy adds no permission prompt, retries, or automatic login changes.

The regression runs on macOS with Command Line Tools and is explicitly skipped elsewhere. Linux and Windows behavior is unchanged. No auth store, credential migration, new configuration option, or generated API change is required.
