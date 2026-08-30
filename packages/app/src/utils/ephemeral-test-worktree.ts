/**
 * Ephemeral test-artifact worktree detection (frontend).
 *
 * Mirrors packages/synergy/src/scope/test-artifacts.ts. The browser has no
 * `os.tmpdir()`, so the frontend can only use the basename prefix signal:
 * fixture scopes persisted under the OS temp directory carry a
 * `synergy-test-*` / `synergy-orchestrated-*` basename, while real project
 * directories (e.g. `/Users/eric/projects/synergy-test/3d-software-rasterizer-pro`)
 * never match that prefix.
 */

const EPHEMERAL_TEST_PREFIXES = ["synergy-test-", "synergy-orchestrated-"] as const

export function isEphemeralTestWorktree(worktree: string): boolean {
  const base = worktree.split("/").pop()?.split("\\").pop() ?? ""
  return EPHEMERAL_TEST_PREFIXES.some((prefix) => base.startsWith(prefix))
}
