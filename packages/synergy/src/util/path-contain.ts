import path from "path"
import { lstatSync, readlinkSync, realpathSync } from "fs"

// Matches the kernel SYMLOOP_MAX: chains deeper than this are loops, and the
// OS refuses to resolve them anyway — remaining components stay lexical.
const SYMLINK_DEPTH_LIMIT = 40

// realpathSync.native may return Windows device-prefixed forms (\\?\C:\...,
// \\?\UNC\server\share). canonicalize() mixes whole-path realpath results with
// component-walk results; every returned form must land in the same coordinate
// system or containment comparisons on Windows would falsely report escapes.
function stripDevicePrefix(p: string): string {
  if (p.startsWith(`\\\\?\\UNC\\`)) return `\\\\${p.slice(8)}`
  if (p.startsWith(`\\\\?\\`) || p.startsWith(`\\??\\`)) return p.slice(4)
  return p
}

function joinAll(base: string, components: string[]): string {
  return components.length ? path.join(base, ...components) : base
}

/**
 * Canonicalize a path by resolving symlinks wherever they sit in it, while
 * keeping genuinely missing components lexical.
 *
 * Used by {@link isPathContained} so an in-project symlink whose target lies
 * outside the workspace cannot bypass the boundary check. Whole-path realpath
 * alone is not sufficient: it fails with ENOENT whenever any component does
 * not exist — most commonly the final one, a file about to be written — and
 * falling back to a lexical form there re-opens the escape for writes through
 * an existing link (BUG-001). Resolving component by component follows links
 * at any depth while missing tails, which have no link to follow, stay
 * lexical. Dangling links (target missing) are resolved through readlink so a
 * write that would create the target outside the boundary is still detected.
 *
 * Components that cannot be resolved at all (missing, EACCES, ELOOP past the
 * depth cap) keep their lexical form, which is never wider than the pre-fix
 * behavior.
 */
function canonicalize(input: string, depth = 0): string {
  if (depth > SYMLINK_DEPTH_LIMIT) return path.resolve(input)
  const resolved = path.resolve(input)
  try {
    return stripDevicePrefix(realpathSync.native(resolved))
  } catch {
    // The path does not fully exist — resolve it component by component.
  }
  const { root } = path.parse(resolved)
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean)
  let current = root
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!
    const candidate = path.join(current, component)
    let stat: ReturnType<typeof lstatSync> | undefined
    try {
      stat = lstatSync(candidate)
    } catch {
      stat = undefined
    }
    if (!stat) return joinAll(current, components.slice(index))
    if (!stat.isSymbolicLink()) {
      current = candidate
      continue
    }
    const remaining = components.slice(index + 1)
    try {
      const target = realpathSync.native(candidate)
      return canonicalize(stripDevicePrefix(joinAll(target, remaining)), depth + 1)
    } catch {
      // Dangling link: realpath fails because the target is missing, but the
      // link still redirects writes, so resolve it through readlink instead.
      try {
        const link = stripDevicePrefix(readlinkSync(candidate))
        return canonicalize(joinAll(path.resolve(current, link), remaining), depth + 1)
      } catch {
        return joinAll(current, components.slice(index))
      }
    }
  }
  return current
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
