import path from "path"
import { lstatSync, readlinkSync, realpathSync } from "fs"

// Matches the kernel SYMLOOP_MAX: chains deeper than this are loops, and the
// OS refuses to resolve them. Treat them as unresolvable and fail closed.
const SYMLINK_DEPTH_LIMIT = 40

// realpathSync.native may return Windows device-prefixed forms (\\?\C:\...,
// \\?\UNC\server\share). Every returned form must land in the same coordinate
// system or containment comparisons on Windows would falsely report escapes.
function stripDevicePrefix(p: string): string {
  if (p.startsWith(`\\\\?\\UNC\\`)) return `\\\\${p.slice(8)}`
  if (p.startsWith(`\\\\?\\`) || p.startsWith(`\\??\\`)) return p.slice(4)
  return p
}

function joinAll(base: string, components: string[]): string {
  return components.length ? path.join(base, ...components) : base
}

export interface PathContainedOptions {
  /**
   * When false, a symlink in the FINAL component is not followed: the check
   * judges the directory entry itself. Pathname-mutating operations (rm, mv,
   * ln) act on the entry — an external link that points into the workspace is
   * still an external entry, while content operations follow the link.
   * Intermediate symlinks are always followed regardless of this flag.
   */
  followFinalSymlink?: boolean
}

/**
 * Split a path into its root and raw components WITHOUT collapsing `..`:
 * path.resolve/path.join would fold `link/../victim` before the link is
 * inspected, while the OS resolves `..` only after following the link.
 */
function splitComponents(input: string): { root: string; components: string[] } {
  const stripped = stripDevicePrefix(input)
  const { root } = path.parse(stripped)
  const components = stripped.slice(root.length).split(path.sep).filter(Boolean)
  return { root, components }
}

/**
 * Walk components against a physical prefix, resolving symlinks wherever they
 * sit and keeping genuinely missing components lexical.
 *
 * `current` is always a physically resolved directory (realpath'ed or built
 * from existing non-symlink components), so `..` components resolve against
 * the physical target — matching OS semantics. A symlink component is
 * followed by recursing on its resolved target plus the remaining components;
 * a dangling link (target missing) is still resolved through readlink so a
 * write that would create the target outside the boundary is detected.
 *
 * Returns null when the path cannot be resolved safely (EACCES/EPERM/EIO/...,
 * or a link chain past SYMLOOP_MAX). Callers must treat null as NOT contained
 * (fail closed): an unresolved suffix may hide an escape link.
 */
function walk(current: string, components: string[], depth: number): string | null {
  if (depth > SYMLINK_DEPTH_LIMIT) return null
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!
    if (component === ".") continue
    if (component === "..") {
      // Applied to the physically resolved prefix so far.
      const parent = path.dirname(current)
      if (parent !== current) current = parent
      continue
    }
    const candidate = path.join(current, component)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // Permission, I/O, or resource failure: we cannot see whether a link
        // hides in the unresolved suffix — fail closed instead of widening.
        return null
      }
      // Genuinely missing tail: no link to follow. Keep it lexical and fold
      // any trailing `..` against the resolved prefix.
      return path.normalize(joinAll(current, components.slice(index)))
    }
    if (!stat.isSymbolicLink()) {
      current = candidate
      continue
    }
    const remaining = components.slice(index + 1)
    try {
      // The target resolves fully (any `..` or inner links inside it are
      // already handled by realpath), then the remaining components continue
      // the walk — including any `..`, which now resolve physically.
      const target = stripDevicePrefix(realpathSync.native(candidate))
      const { root, components: targetComponents } = splitComponents(target)
      return walk(root, [...targetComponents, ...remaining], depth + 1)
    } catch {
      // Dangling link: realpath fails because the target is missing, but the
      // link still redirects writes, so resolve it through readlink instead.
      // A relative target resolves against the link's parent (`current`), and
      // any `..` inside it is applied by the walk in OS order.
      try {
        const link = stripDevicePrefix(readlinkSync(candidate))
        const parts = link.split(path.sep).filter(Boolean)
        if (path.isAbsolute(link)) {
          const { root, components: targetComponents } = splitComponents(link)
          return walk(root, [...targetComponents, ...remaining], depth + 1)
        }
        return walk(current, [...parts, ...remaining], depth + 1)
      } catch {
        return null
      }
    }
  }
  return current
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
 * `..` components are kept until symlinks have been resolved: collapsing them
 * up front would erase the link to inspect (`workspace/link/../victim` must
 * resolve the link first, then apply `..` to its physical target, which is
 * what the OS does).
 *
 * Returns null when the path cannot be resolved safely (EACCES/EPERM/EIO/...,
 * or a link chain past SYMLOOP_MAX). Callers must treat null as NOT contained
 * (fail closed): an unresolved suffix may hide an escape link.
 */
function canonicalize(input: string, depth = 0, options: PathContainedOptions = {}): string | null {
  if (depth > SYMLINK_DEPTH_LIMIT) return null
  // Absolutize without folding `..`: path.resolve/join would collapse
  // link/../victim before the link is inspected, while the OS resolves `..`
  // after following the link.
  const raw = path.isAbsolute(input) ? input : `${process.cwd()}${path.sep}${input}`
  const stripped = stripDevicePrefix(raw)
  if (options.followFinalSymlink === false) {
    // Pathname-mutating operation (rm/mv/ln): judge the final directory entry
    // itself, not its target — an external link pointing into the workspace
    // is still an external entry. Canonicalize the parent with default
    // (follow) semantics so both sides stay in one coordinate system, then
    // re-join the final component lexically.
    const finalComponent = path.basename(stripped)
    if (finalComponent !== "" && finalComponent !== "." && finalComponent !== "..") {
      const dir = path.dirname(stripped)
      const canonicalDir = dir === stripped ? stripped : canonicalize(dir, depth + 1)
      if (canonicalDir === null) return null
      return path.join(canonicalDir, finalComponent)
    }
  }
  try {
    return stripDevicePrefix(realpathSync.native(stripped))
  } catch {
    // The path does not fully exist — resolve it component by component.
  }
  const { root, components } = splitComponents(stripped)
  return walk(root, components, depth)
}

export function isPathContained(parent: string, child: string, options: PathContainedOptions = {}): boolean {
  const resolvedParent = canonicalize(parent)
  const resolvedChild = canonicalize(child, 0, options)
  if (resolvedParent === null || resolvedChild === null) return false
  const relative = path.relative(resolvedParent, resolvedChild)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function resolveContainedPath(base: string, filePath: string): string | null {
  // Do not fold `..` before the containment check: the walk resolves `..`
  // against the physically resolved prefix, matching OS semantics. When
  // contained, return the canonical path so callers open exactly what the OS
  // would resolve — never a lexically re-collapsed alias of an escape link.
  const candidate = path.isAbsolute(filePath) ? filePath : `${base}${path.sep}${filePath}`
  if (!isPathContained(base, candidate)) return null
  return canonicalize(candidate)
}

/**
 * Path containment check.
 * Returns the resolved absolute path if contained, null if traversal detected.
 */
export function checkPathContainment(base: string, filePath: string): string | null {
  return resolveContainedPath(base, filePath)
}
