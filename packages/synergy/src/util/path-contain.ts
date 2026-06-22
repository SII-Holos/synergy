import path from "path"

/**
 * Path containment check.
 * Returns the resolved absolute path if contained, null if traversal detected.
 */
export function checkPathContainment(base: string, filePath: string): string | null {
  const resolved = path.resolve(base, filePath)
  const relative = path.relative(base, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null
  }
  return resolved
}
