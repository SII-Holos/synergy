import os from "os"
import path from "path"
import { realpathSync } from "fs"

/**
 * Ephemeral test-artifact worktree detection.
 *
 * Test runs persist fixture scopes whose worktree lives under the OS temp
 * directory with a `synergy-test-*` / `synergy-orchestrated-*` basename.
 * Historically (pre TestHomeGuard, see postmortem 0001) those records leaked
 * into a real home and permanently pollute every scope list. The macOS
 * `os.tmpdir()` (`/var/folders/.../T`) and the realpath persisted by fixture
 * scaffolding (`/private/var/folders/.../T`) differ in prefix but never in
 * basename, so the basename prefix is the primary cross-platform signal.
 *
 * The frontend (packages/app) runs in a browser without `os.tmpdir()`, so it
 * can only use the basename signal. The backend additionally verifies the
 * worktree actually resolves inside the OS temp directory so a real directory
 * named `synergy-test-*` outside tmp never gets filtered.
 */

const EPHEMERAL_TEST_PREFIXES = ["synergy-test-", "synergy-orchestrated-"] as const

export function isEphemeralTestWorktreeBasename(worktree: string): boolean {
  const base = path.posix.basename(worktree.replace(/\\/g, "/"))
  return EPHEMERAL_TEST_PREFIXES.some((prefix) => base.startsWith(prefix))
}

export function isEphemeralTestWorktree(worktree: string): boolean {
  if (!isEphemeralTestWorktreeBasename(worktree)) return false
  // Secondary guard: only treat it as ephemeral when it really lives under
  // the OS temp directory. This prevents filtering a real project directory
  // that happens to be named `synergy-test-*` outside tmp.
  const tmpRoot = path.resolve(os.tmpdir())
  const candidate = path.resolve(worktree)
  if (candidate === tmpRoot || candidate.startsWith(tmpRoot + path.sep)) return true
  // macOS realpath forms (/private/var/... vs /var/...) may differ; resolve
  // both sides before comparing when the directory still exists.
  try {
    const realCandidate = realpathSync(candidate)
    const realTmp = realpathSync(tmpRoot)
    return realCandidate === realTmp || realCandidate.startsWith(realTmp + path.sep)
  } catch {
    return false
  }
}
