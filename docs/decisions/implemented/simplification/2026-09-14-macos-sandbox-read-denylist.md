# Decision Record: Deny-list read model for the macOS deny-default sandbox

Status: implemented

## Problem

Every real CLI tool reads configuration outside the workspace (`gh` reads `~/.config/gh`, Kubernetes tools read `~/.kube`, language toolchains read their own caches), but the macOS deny-default backend allowed reads only through an enumerated root list (`DEFAULT_USER_RUNTIME_READ_ROOTS` + platform roots). The control-plane policy layer already treats `autonomous` reads as deny-list-shaped (`readRoots: ["/"]`), so the two layers disagreed by construction: any host path present in the policy's legal set but absent from the sandbox's enumeration failed at execution time with `Operation not permitted`. Fixing this per-tool meant growing the enumeration forever — git alone took three rounds (user runtime roots, sibling-deny exceptions, worktree gitdir grants) and `gh` still failed because `~/.config/gh` was never enumerated.

## Decision

The macOS deny-default Seatbelt compiler flips the read side to a deny list. `compileProfile` emits a bare `(allow file-read*)` and denies reads only for the credential and sensitive-data paths in `READ_DENY_PATHS` (`packages/harness/src/sandbox/policy.ts`); a subpath deny is more specific than the bare global allow and wins under Seatbelt's most-specific-match resolution, verified with real `sandbox-exec` runs on macOS 26.6. Write containment is untouched: writes stay denied everywhere except the parameterized writable roots, `.git/hooks` and `.git/config` stay read-only inside writable roots, and `.agents`/`.codex` stay blanket-protected.

`READ_DENY_PATHS` extends `CREDENTIAL_PATHS` with `.git-credentials`, `.azure`, `.kube`, and the browser/mail data stores (`~/Library/Cookies`, `~/Library/Mail`, Firefox, Chrome, Edge, Brave profiles) that a global read allow would otherwise expose. `~/.config/gh` is deliberately not denied: gh hard-fails when it cannot read `hosts.yml` as configuration even with `GH_TOKEN` present, keyring mode keeps tokens out of that directory, and the Bash tool injects the managed GitHub credential as `GH_TOKEN`. Deny entries that equal, fall inside, or contain the workspace or a writable root are dropped at profile build so a project rooted at a credential location keeps its own files readable.

The enumerated worktree gitdir grants ([worktree gitdir enumerated sandbox read grants](../../implemented/bug-fix/2026-09-09-worktree-gitdir-enumerated-sandbox-grants.md)) remain, but now only gate what bind-based backends mount: on macOS the global read allow already covers those paths, while the Linux helper still needs the existence-filtered sources. The `PATH_READ_*` parameter rules, sibling-deny generation, and ancestor metadata allows are removed from the macOS compiler together with the now-unused `SBPL_PARAM_NAME` helper.

## Alternatives considered

**Keep enumerating read roots and add `~/.config/gh`.** One line, but it reopens the decision every time a new tool appears and leaves every unenumerated tool failing in unattended sessions; the two-layer disagreement is structural, not a missing entry.

**Bypass the sandbox for autonomous bash.** Removes the only containment layer for writes that static classification cannot see (variable redirect targets) and, on the read side, exposes every credential store; the deny-list model keeps both write containment and credential denial.

**Global `file-read-data` allow with `file-read*` denies.** The 2026-09-04 containment record reports this shape lost to deny rules in its probes; the shipped rule shape pairs the bare `(allow file-read*)` with subpath `(deny file-read* …)` so both sides use the same filter class and the more specific rule wins — verified by real sandbox-exec probes (ssh key and denied file unreadable, arbitrary host file readable).

**Flip the Linux backend too.** bwrap exposes the filesystem through bind mounts from a tmpfs root, so "allow everything then deny" has no native expression — the closest equivalent (`--ro-bind / /`) mounts the whole host read-only and its interaction with protected-path ro-binds is an unproven surface. Linux keeps the enumeration model; its grant list is small because the helper mounts what the profile says.

## Consequences

Tools whose configuration lives anywhere on the host now run in sandboxed macOS sessions without per-tool enumeration; `gh`, docker, and Kubernetes CLIs read their configs through the global allow and authenticate via injected environment credentials. Credential files, agent configs, shell rc files, and browser/mail stores stay unreadable, and Keychain stays unreachable because the securityd mach lookup never enters the profile. The read-deny list is now the security-relevant surface: a credential location missing from `READ_DENY_PATHS` is readable by default, so new credential stores must be added there (the list is the deny complement of what the policy layer always considered public). Host file contents outside credential paths — including other projects' source — are readable by sandboxed processes, which matches the policy layer's existing `readRoots: ["/"]` semantics for autonomous and is the price of ending the enumeration treadmill. Linux behavior is unchanged.
