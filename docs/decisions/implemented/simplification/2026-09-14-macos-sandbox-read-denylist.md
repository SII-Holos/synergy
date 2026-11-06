# Decision Record: Deny-list read model for the macOS deny-default sandbox

Status: implemented

## Problem

Every real CLI tool reads configuration outside the workspace (`gh` reads `~/.config/gh`, Kubernetes tools read `~/.kube`, language toolchains read their own caches), but the macOS deny-default backend allowed reads only through an enumerated root list (`DEFAULT_USER_RUNTIME_READ_ROOTS` + platform roots). The control-plane policy layer already treats `autonomous` reads as deny-list-shaped (`readRoots: ["/"]`), so the two layers disagreed by construction: any host path present in the policy's legal set but absent from the sandbox's enumeration failed at execution time with `Operation not permitted`, and unattended sessions had no approval path to fix it. Patching the enumeration per tool (git alone took three rounds) never converged.

## Decision

The macOS deny-default Seatbelt compiler flips the read side to a deny list. `compileProfile` emits a bare `(allow file-read*)` and denies reads only for the paths in `READ_DENY_PATHS` (`packages/harness/src/sandbox/policy.ts`); a subpath deny emitted after the bare global allow wins, because Seatbelt applies the last matching rule rather than ranking by specificity — verified with real `sandbox-exec` runs on macOS 26. Write containment is untouched: writes stay denied everywhere except the parameterized writable roots, `.git/hooks` and `.git/config` stay read-only inside writable roots, and `.agents`/`.codex` stay blanket-protected.

`READ_DENY_PATHS` derives from `CREDENTIAL_PATHS` (extended with `.git-credentials`, `.azure`, `.kube`, the plugin credential root `.synergy/data/plugin`, and Cargo registry token files) plus browser and mail data stores (`~/Library/Cookies`, `~/Library/Mail`, and the `Application Support` profile roots of Firefox, Chrome, Edge, and Brave — Firefox profiles on macOS live under `Application Support`, not `~/Library/Firefox`). Denies are derived from every read-deny home — the OS user home plus the Synergy runtime home when `SYNERGY_HOME`/`SYNERGY_TEST_HOME` points elsewhere (`readDenyHomeDirs()`) — so custom runtime homes keep their provider/MCP/account/plugin stores protected. Explicit non-default `dataDenyRoots` from a permission profile merge into the compiled read denies instead of being discarded.

An entry that contains the workspace or a writable root is kept and emitted before the writable-root allow, so a workspace nested inside a credential directory (for example `~/.ssh/proj`) works while its credential siblings (`~/.ssh/id_rsa`) stay unreadable — verified with a real sandbox-exec carve-out probe. An entry inside a writable root is also kept and emitted after that allow; dropping those entries, and emitting the rest before it, is corrected in [read denies survive every workspace shape](../../implemented/bug-fix/2026-09-19-read-deny-survives-every-workspace-shape.md).

Tool-compatibility read exemptions (operator decision, 2026-09-14): `~/.kube` and `~/.docker/config.json` stay readable. kubectl and docker load their config stores at startup with no credential-injection fallback (a kubeconfig embeds client certs and tokens; docker reads config.json for registry auth), so denying the store breaks the tool outright; write protection is unaffected because both stay in `CREDENTIAL_PATHS`. Reverting to strict read denial is a one-entry change in `READ_EXEMPT_CREDENTIAL_PATHS`.

`~/.config/gh` is deliberately not denied: gh hard-fails when it cannot read `hosts.yml` as configuration even with `GH_TOKEN` present (verified with a sandboxed probe), keyring mode keeps the token out of that directory, and the Bash tool injects the managed GitHub credential as `GH_TOKEN` for gh invocations.

The enumerated worktree gitdir grants ([worktree gitdir enumerated sandbox read grants](../../implemented/bug-fix/2026-09-09-worktree-gitdir-enumerated-sandbox-grants.md)) remain, but now only gate what bind-based backends mount: on macOS the global read allow already covers those paths, while the Linux helper still needs the existence-filtered sources. The `PATH_READ_*` parameter rules, sibling-deny generation, and ancestor metadata allows are removed from the macOS compiler together with the now-unused `SBPL_PARAM_NAME` helper.

## Alternatives considered

**Keep enumerating read roots and add `~/.config/gh`.** One line, but it reopens the decision every time a new tool appears and leaves every unenumerated tool failing in unattended sessions; the two-layer disagreement is structural, not a missing entry.

**Per-tool credential injection (extending the GH_TOKEN bridge to kubectl, docker, …).** Moves the enumeration treadmill from read paths to credential formats: every tool's auth storage needs bespoke bridge code that never converges. The deny-list read model plus a small explicit exemption set handles tool compatibility without per-tool code.

**Bypass the sandbox for autonomous bash.** Removes the only containment layer for writes that static classification cannot see (variable redirect targets) and, on the read side, exposes every credential store; the deny-list model keeps both write containment and credential denial.

**Global `file-read-data` allow with `file-read*` denies.** The 2026-09-04 containment record reports this shape lost to deny rules in its probes; the shipped rule shape pairs the bare `(allow file-read*)` with subpath `(deny file-read* …)` so both sides use the same filter class and the more specific rule wins — verified by real sandbox-exec probes (ssh key and denied file unreadable, arbitrary host file readable).

**Flip the Linux backend too.** bwrap exposes the filesystem through bind mounts from a tmpfs root, so "allow everything then deny" has no native expression — the closest equivalent (`--ro-bind / /`) mounts the whole host read-only and its interaction with protected-path ro-binds is an unproven surface. Linux keeps the enumeration model; its grant list is small because the helper mounts what the profile says.

## Consequences

Tools whose configuration lives anywhere on the host run in sandboxed macOS sessions without per-tool enumeration: `gh` reads `~/.config/gh` and authenticates through the injected `GH_TOKEN`; kubectl and docker read their stores through the explicit exemptions. Credential files (SSH/GPG/AWS/Azure/cloud CLIs, Cargo registry tokens, the Synergy auth and plugin stores), agent configs, shell rc files, and browser/mail stores stay unreadable, while native Keychain service access follows the superseding [Keychain service decision](../bug-fix/2026-09-21-macos-keychain-service-access.md). The read-deny list is now the security-relevant surface: a credential location missing from `READ_DENY_PATHS` is readable by default, so new credential stores must be added there. Sandbox processes can read kubeconfigs and docker registry credentials — the accepted price of the tool-compatibility exemption, recorded above as an explicit operator decision. Host file contents outside credential paths — including other projects' source — are readable by sandboxed processes, matching the policy layer's existing `readRoots: ["/"]` semantics for autonomous. Linux behavior is unchanged.
