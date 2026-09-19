# Decision Record: Linux sandbox readable roots follow host reality

Status: implemented

## Problem

On Linux, the helper-backed sandbox compiled its permission profile from a shared, macOS-first root list. `defaultRuntimeReadRoots` includes `/System/Library` and `~/Library/Caches/…` regardless of host platform, and `LinuxBackend.prepare` passed readable roots through unfiltered even though protected paths and network config roots were already existence-filtered. bwrap hard-fails when a `--ro-bind` source is missing, so on every Linux host an `autonomous` Bash call died at mount setup (`bwrap: Can't find source path /System/Library`). The failure was invisible on hosts where bwrap died earlier in netns setup (for example Ubuntu 24.04 with AppArmor restricting unprivileged user namespaces); fixing that environment exposed this second failure, and after adding the missing roots a third surfaced: the profile was staged in the host tmpdir, which stage 2 cannot read inside the sandbox because restricted mode covers `/` with tmpfs and the only `/tmp` is the workspace controlled-tmp bind. Separately, the linker roots (`/lib`, `/lib64` — the ELF interpreter entry points on usr-merged distros) were never bound, so even with a readable profile every dynamically linked child died with `execvp ENOENT`.

## Decision

`LinuxBackend.prepare` (`packages/runtime-local/src/sandbox/linux.ts`) owns platform mount reality:

- All readable roots — workspace, `runtimeReadRoots`/defaults, extra read roots, and network config roots — are deduplicated and existence-filtered at wrapper preparation, the same invariant protected paths already follow.
- `/lib` and `/lib64` are added when present so dynamically linked children can load their interpreter. Restricted mode still excludes `/etc`; it stays in the full-network branch only.
- The permission profile is staged under `~/.synergy/cache/synergy-sandbox/` — a default sandbox read root that is never under `/tmp`, so the plan's final controlled-`/tmp` bind cannot shadow it and stage 2 re-reads the same absolute path inside the sandbox. A home that cannot host it falls back to the workspace controlled tmp and then the host tmpdir with a warning; those paths are stage-1-only whenever they sit under `/tmp`.

## Alternatives considered

**Filter inside the Rust helper.** Rejected: the helper is a hash-verified release asset; a behavior change forces rebuilding and re-trusting every packaged binary, and existence filtering belongs with the TS layer that already filters protected paths the same way.

**Filter in `buildPermissionProfile` (harness policy engine).** Rejected: the policy layer expresses intent and must stay platform-neutral. macOS Seatbelt tolerates missing paths and existing tests assert macOS roots; filtering there would silently change cross-platform policy semantics.

**Pass the profile through stdin or an inherited fd.** Rejected: the file path is the established TS↔Rust interop contract consumed by both the Linux and Windows helpers; changing it widens the blast radius far beyond the defect.

**Fall back to `--ro-bind / /` when enumerated roots are missing.** Rejected: restricted mode must never expose the full host root; that inverts the sandbox's read posture and violates the "never ro-bind the whole root" invariant.

> **Superseded in part.** The "never `--ro-bind` the whole root" invariant this
> record defends was reversed one day later by
> [Full-disk read on Linux matching the accepted macOS deny-list model](../simplification/2026-09-19-linux-sandbox-full-read-model.md):
> Linux now declares `/` as its single readable root so the helper binds the
> host root read-only, and keeps credentials unreadable through a deny list
> instead. The enumerated read-root model described above no longer ships. The
> staging, `/lib`/`/lib64`, and two-stage re-exec decisions in this record
> remain current.

## Consequences

Linux `autonomous` Bash now works on a stock Ubuntu 24.04 host once the operator allows bwrap's user namespace (an environment fix outside this repository — an AppArmor profile granting `/usr/bin/bwrap` `userns`), and on any host without macOS-specific paths. macOS behavior is unchanged: Seatbelt ignores nonexistent subpaths and consumes an unchanged profile. Added test coverage lives in `packages/runtime-local/test/sandbox/linux-readable-roots.test.ts`, including a real end-to-end execution that skips honestly where the host has no helper or blocks user namespaces. Remaining known gap: sandbox readiness still probes only `bwrap --version` and sysctls, so an environment that blocks namespace creation passes readiness while execution fails; a functional bwrap probe and exec-time failure classification into `SandboxBlocked` diagnostics are future work.

A separate discovery recorded here because it constrains tests and docs: the helper's controlled-tmp bind shadows every host path under `/tmp`, including a workspace that lives there, so sandboxed execution requires the workspace to sit outside `/tmp` — production workspaces always do, and the end-to-end test mirrors that by staging its fixture under the runtime tmp root.

CI enforces this coverage: the `Test Shards (runtime)` job installs `bubblewrap`, loads the operator AppArmor userns profile for `/usr/bin/bwrap`, builds and installs the helper to `~/.synergy/sandbox-helper/`, and exports `SYNERGY_TEST_LINUX_SANDBOX_E2E=1` (declared in the turbo `test` task `env` so strict environment mode passes it through and caches runs distinctly). Under that flag every skip condition in the end-to-end test becomes a hard failure naming the missing prerequisite, so a broken Linux sandbox can no longer hide behind a green build; local runs without the flag keep the honest skips.

Enforcing the e2e on CI surfaced a fourth latent defect the honest skips had also hidden. A helper resolved under the host tmpdir — test homes (`SYNERGY_TEST_HOME`) and custom setups — sits under the plan's final controlled-`/tmp` bind, which shadows every host path under `/tmp`: stage 2 re-execs the same absolute path inside the sandbox and dies with `execvp ENOENT` before any command runs. Production worked only because its helper installs under the real home. Verified in a privileged Ubuntu 24.04 container: with a tmpdir helper both OS-execution tests fail (`exit 1`, empty stdout); with the staging fix both pass. The backend now stages a verified copy of a tmpdir-resolved helper into `~/.synergy/cache/synergy-sandbox/` (the same shadow-free directory the profile uses), execs that copy, and binds the exec directory as a read root — the backend owns the two-stage re-exec contract, so callers never need to know about the helper.
