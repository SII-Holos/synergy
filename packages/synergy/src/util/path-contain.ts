import path from "path"
import { realpathSync } from "fs"

/**
 * Resolve a path to its canonical physical form, following symlinks.
 *
 * Used by {@link isPathContained} so that an in-project symlink whose target
 * lies outside the workspace cannot bypass the boundary check: the resolved
 * target is compared against the (equally canonicalized) parent.
 *
 * If the path does not exist, realpath cannot resolve it. Falling back to the
 * lexical {@link path.resolve} result in that case preserves the pre-fix
 * behavior for not-yet-created paths (e.g. a file about to be written) rather
 * than widening access — a non-existent path has no link to follow, so the
 * lexical check is still safe there. Existing paths that fail to resolve for
 * other reasons (e.g. EACCES) likewise fall back conservatively.
 *
 * (BUG-001: previously this function was purely lexical, so a symlink inside
 * the workspace pointing at e.g. /etc or os.tmpdir() was treated as contained.
 * `Filesystem.normalizePath` performs the equivalent realpath-based casing
 * normalization on Windows; it is not reused here to avoid a circular import
 * — filesystem.ts imports isPathContained from this module — and because in
 * the fallback branch realpath has already failed, so normalizePath would only
 * re-attempt the same failing call.)
 */
function canonicalize(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

export function isPathContained(parent: string, child: string): boolean {
  const resolvedParent = canonicalize(parent)
  const resolvedChild = canonicalize(child)
  const relative = path.relative(resolvedParent, resolvedChild)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function resolveContainedPath(base: string, filePath: string): string | null {
  const resolved = path.resolve(base, filePath)
  return isPathContained(base, resolved) ? resolved : null
}

/**
 * Path containment check.
 * Returns the resolved absolute path if contained, null if traversal detected.
 */
export function checkPathContainment(base: string, filePath: string): string | null {
  return resolveContainedPath(base, filePath)
}
