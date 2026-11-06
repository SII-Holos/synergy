# Decision Record: Canonicalize macOS sandbox paths that do not exist yet

Status: implemented

## Problem

`MacOSPolicy.compileProfile` (`packages/local-runtime/src/sandbox/macos-policy.ts`) emitted the parameterized writable-root allow through `canonicalize()`, but its own `canonicalize()` fell back to the raw input whenever `realpathSync` threw — the normal case for a protected subpath that does not exist yet, since denying `<workspace>/.git/hooks` matters precisely when nothing has created it. On a firmlinked host the two rules then used different spellings: the allow was bound to the kernel-canonical `/private/var/folders/...` while the deny was emitted as the `/var/folders/...` alias the caller supplied. A deny scoped to a path the kernel never resolves does not intersect the allow, so the deeper write allow won.

Observed before the fix, on a workspace addressed through the `/var/folders/...` alias with `.git/hooks` absent at prepare time:

```
alias-spelling probe     => stdout="WROTE"  hook-planted=true
canonical-spelling probe => stdout="BLOCKED" hook-planted=false
```

Two independent conditions were required — an uncanonicalized workspace spelling and `.git/hooks` not existing when the profile was compiled — which is why the escape looked intermittent and why the same command addressed via `/private/var/...` was blocked. The defect was in path canonicalization, not in the protected-path rule set, and it also affected `readDenyPaths` (`.ssh` canonicalized while `.gnupg` stayed aliased) and any symlink-aliased workspace.

## Decision

`canonicalize()` resolves the nearest existing ancestor with `realpathSync` and re-appends the remaining components, so a path whose final component does not exist still resolves to its canonical spelling instead of degenerating to the caller's spelling. Only a path with no existing ancestor falls back to the input, because the root is always its own canonical form.

Both spellings of an aliased workspace then produce intersecting allow and deny rules. The fix is general rather than a `.git/hooks` special case: it applies to every caller of `canonicalize()` — `writableRoots` params, `readOnlySubpaths`, and `readDenyPaths` — and to every aliasing mechanism the kernel resolves the same way, including firmlinks, symlinked workspaces, symlinked or dangling intermediate components, and `..` segments in the missing tail.

Workspace writes still succeed and protected-path denies still apply; the containment baseline asserts both polarities through the real `sandbox-exec` wrapper rather than on generated policy text.

## Alternatives considered

- **Special-case `.git/hooks` and `.git/config`** — rejected: the escape is a property of the canonicalization primitive, and the same divergence also mis-scoped `readDenyPaths`, so a targeted patch would have left the credential deny list aliasing-prone and reappeared on the next protected subpath.
- **Always deny both spellings** — rejected: it requires enumerating every alias the caller might use, which is unbounded (firmlinks, symlinks, `..`), and a deny still must intersect the single canonical allow to be effective.
- **Fail closed when the path does not exist** — rejected: this would deny legitimate protected subpaths that are not yet created, and it cannot fail closed for `readDenyPaths` without unreadable-credential regressions.
- **Reuse `canonicalize` from `packages/harness/src/util/path-contain.ts`** — rejected: that implementation is private and fail-closed (`string | null`), whereas SBPL generation needs a total `string -> string` mapping for every emitted rule. It also resolves component-wise with `readlinkSync` because it answers a containment question; this call site only needs the kernel's spelling of a path it has already decided to allow or deny. Sharing it would require widening its contract for no gain.
- **Gate the deny on existence and skip missing subpaths** — rejected: it silently drops the protection exactly in the pre-creation window the deny exists to cover.

## Consequences

Protected subpaths and credential read denies are now emitted in the same coordinate system as the writable-root allow, so the firmlink-alias escape is closed for both. A workspace reached through an alias no longer widens its own `.git`, `.agents`, or `.codex` surface.

`canonicalize()` performs one extra `realpathSync` walk per missing component at profile-compile time, which is bounded by path depth and runs once per wrapper preparation rather than per command. The `sandbox-network-git-parity` read-deny assertion now compares the protected relative location against either the raw or the firmlinked home spelling, because macOS firmlinks the home itself and the compiled rule may legitimately carry either form.

The `.synergy`/`.agents`/`.codex` protected _metadata names_ still compile to kernel-independent `(regex #"/\.name/")` rules and are unaffected. A residual gap remains unaddressed: the opt-in `seatbelt-legacy-allow-default` backend (`MacBackend.generateSeatbeltProfile`) interpolates paths verbatim and shows the same alias escape, but it is a non-default compatibility backend that the deny-default compiler superseded.
