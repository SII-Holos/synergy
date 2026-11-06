# Decision Record: Preserve worktree Git reads under ancestor denies

Status: implemented

## Problem

A linked worktree inside a sensitive-name ancestor could write its own files but fail every Git read. The macOS deny-list allowed the selected workspace while denying the external common Git store. Existing worktree read grants reached the gate but did not override this ancestor deny in the native compiler.

## Decision

Carry the selected local workspace's original checkout through the private Executor sandbox input. At compilation, reuse the existing worktree grant validator to verify the pointer, common directory and backlink. Canonicalize the workspace identity and reject redirected metadata files and directories. Emit only the selected workspace and enumerated Git read grants, with metadata-only traversal of their ancestors. Keep explicit read denies equal to or inside those grants effective, and retain all write restrictions.

The native regression in [worktree-read-grants.test.ts](../../../../packages/local-runtime/test/sandbox/worktree-read-grants.test.ts) creates actual linked worktrees and checks object reads, repository discovery, read-only mode, sibling and credential refusal, common-store write refusal, an explicit denied Git file, a forged sibling pointer and redirected metadata. It reproduces Git's failure before the compiler change.

## Alternatives considered

**Grant the whole checkout or common Git directory.** This would expose unrelated files and metadata that the existing contract deliberately excludes.

**Apply every generic readable root after credential denies.** Runtime and skill roots are too broad to act as credential-deny exceptions.

**Move the reproduction elsewhere.** That avoids the path combination without fixing legitimate nested workspaces.

## Consequences

Guarded worktree commands can inspect their repository without widening their writable boundary. Git operations requiring common-store writes retain their existing permission requirements. macOS native checks skip on other platforms; no migration or historical replay is introduced. The Executor field is optional and only local workspace selection supplies it.
