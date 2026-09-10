# Decision Record: Resolve route directories to their owning project before sandbox claims

Status: implemented

## Problem

`resolveProjectScope` in `apps/web/src/utils/scope.ts` resolved a route directory to a project scope with sandbox-first priority, so a directory registered as another project's additional folder (sandbox) shadowed the scope whose worktree the directory actually is. When a directory is simultaneously its own project's worktree and a sandbox entry of an unnamed sibling project, the session top bar, the page-level current project, the mobile drawer highlight, the note panel's scope grouping, and the Blueprint run gating all attributed the directory to the sandbox claimant instead of the owner. Beyond the resolver, four call sites carried their own `worktree === dir || sandboxes?.includes(dir)` mixed predicate, so results depended on scope array order, and directory normalization (separators, casing, trailing slashes, Windows drive letters) drifted between call sites.

## Decision

`resolveProjectScope` is the single directory-to-project resolver for the web app, with priority: (1) exact worktree ownership in the scope list — a directory that is a known project's worktree belongs to that project even when another project registered it as an additional folder; (2) sandbox mapping — a registered sub-directory names its parent project, preserving the intent of [Show active project name in the session top bar](../feature/2026-08-19-session-topbar-project-name.md); (3) active-scope trust as a fallback only, after list matching, because a bootstrap-resolved temporary sub-directory scope must not shadow its persisted parent project. All matching goes through one directory-key normalizer (backslashes to slashes, trailing slashes trimmed, Windows drive/UNC paths case-folded; POSIX paths preserve case). The four ad-hoc mixed-predicate call sites — the page layout's current project, the mobile drawer's active-project highlight, the note panel's current scope ID, and the Blueprint run-session matcher — now delegate to the resolver; the matcher reads the scope `id` through the shared `ProjectScopeCandidate` shape (which gained an optional `id`), and the matcher's private normalizer was deleted.

## Alternatives considered

- **Cleaning the conflicting sandbox entries out of persisted scope data** — rejected: additional folders are explicit user authorization from the project editor, not corruption; silently revoking granted folders would treat a legitimate multi-root setup as a bug, and any newly added same-shape entry would immediately re-trigger the mislabeling.
- **Validating sandbox writes or auto-pruning claimed entries at startup** — rejected for the same authorization reason, plus it would introduce a persisted-state migration surface (fresh-install and upgrade paths) for no benefit once the naming layer resolves ownership correctly.
- **Mapping sandbox directories back to the parent in server-side `Scope.fromDirectory`** — rejected as a cross-layer override: the server's "the opened directory is the project boundary, never traverse upward" contract is deliberate, and rerouting it would change scope persistence, trust roots, and system-prompt project folders to fix a web presentation concern.
- **Trusting the active scope before list matching** — rejected: the active scope can be a bootstrap-resolved temporary sub-directory scope, which must not shadow the persisted parent project; the existing regression test for that case pins list matching ahead of active-scope trust.
- **Fixing each call site's predicate in place** — rejected: it keeps five parallel implementations with divergent normalization, which is the fragmentation this change removes.

## Consequences

- A directory with an exact project owner resolves to that owner everywhere the resolver is used, regardless of array order or which other project also claims it as an additional folder.
- All five directory-to-project lookups share one code path and one normalization rule, so separator and trailing-slash drift no longer affect attribution. Windows paths tolerate case drift; POSIX project identities remain case-sensitive so distinct projects cannot be conflated.
- When several projects claim the same directory as an additional folder and no project owns it exactly, the first claim in the scope list wins — deterministic but still semantically ambiguous; the project editor remains the place for users to resolve the overlap.
- The Blueprint "run in current session" gate now treats a claimed-but-owned directory as the same scope as its owner, a visible behavior change from the previous misattribution.
- No server, SDK, OpenAPI, or persisted-format changes; a single-commit revert is a complete rollback.
