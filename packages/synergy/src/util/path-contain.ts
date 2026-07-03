import path from "path"

export function isPathContained(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  const relative = path.relative(resolvedParent, resolvedChild)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
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
