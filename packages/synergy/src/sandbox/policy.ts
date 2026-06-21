import * as path from "path"

// ------------------------------------------------------------------
// Sandbox policy constants and helpers
//
// Shared by both macOS (Seatbelt) and Linux (bwrap) backends.
// ------------------------------------------------------------------

export const DEFAULT_SYSTEM_RUNTIME_READ_ROOTS = ["/usr/lib", "/System/Library", "/bin", "/usr/bin"]

export const DEFAULT_USER_RUNTIME_READ_ROOTS = (homedir: string): string[] => [
  path.join(homedir, ".gitconfig"),
  path.join(homedir, ".config", "git"),
  path.join(homedir, ".bun"),
  path.join(homedir, ".synergy", "cache"),
  path.join(homedir, "Library", "Caches", "bun"),
  path.join(homedir, "Library", "Caches", "com.oven-sh.bun"),
]

export function defaultRuntimeReadRoots(homedir: string): string[] {
  return [...DEFAULT_SYSTEM_RUNTIME_READ_ROOTS, ...DEFAULT_USER_RUNTIME_READ_ROOTS(homedir)]
}

export function uniqueRoots(roots: string[]): string[] {
  return [...new Set(roots.filter(Boolean))]
}

export function ancestorLiterals(root: string): string[] {
  const resolved = path.resolve(root)
  const result: string[] = []
  let current = resolved
  while (current && current !== path.dirname(current)) {
    result.push(current)
    current = path.dirname(current)
  }
  result.push(current || path.parse(resolved).root)
  return result.reverse()
}

export function traversalLiterals(roots: string[]): string[] {
  return uniqueRoots(roots.flatMap((root) => ancestorLiterals(root)))
}

// ------------------------------------------------------------------
// Credential-bearing paths that must ALWAYS be protected inside any sandbox.
// Each path is read-only mounted (or denied writes on macOS) unconditionally.
//
// Lessons from real-world sandbox escapes:
//   - Cymulate 2026: Gemini CLI OAuth leak via ~/.gemini/oauth_creds.json mounted RW
//   - CBSE (Cross-Agent Sandbox Bypass Exploit): agent config cross-contamination
// ------------------------------------------------------------------
export const CREDENTIAL_PATHS = (homedir: string): string[] => [
  // ── Synergy internal ───────────────────────────────────────────
  // Protects against: CBSE config/prompt leak, credential exfiltration
  path.join(homedir, ".synergy", "config"),
  path.join(homedir, ".synergy", "data", "auth"),
  path.join(homedir, ".synergy", "data", "engram"),
  path.join(homedir, ".synergy", "data", "notes"),
  // ── Network & cloud credentials ─────────────────────────────────
  // Protects against: SSH key theft, cloud credential exfiltration, GPG key compromise
  path.join(homedir, ".netrc"),
  path.join(homedir, ".ssh"),
  path.join(homedir, ".gnupg"),
  path.join(homedir, ".aws"),
  path.join(homedir, ".config", "gcloud"),
  path.join(homedir, ".docker", "config.json"),
  path.join(homedir, ".npmrc"),
  // ── Shell configs (prevent command injection) ────────────────────
  // Protects against: shell injection via sandboxed process rewriting shell rc files
  path.join(homedir, ".bashrc"),
  path.join(homedir, ".zshrc"),
  path.join(homedir, ".profile"),
  path.join(homedir, ".bash_profile"),
  path.join(homedir, ".zprofile"),
  // ── Other agent configs ─────────────────────────────────────────
  // Protects against: CBSE — cross-agent sandbox bypass via reading/writing
  // another agent's configuration, credentials, or prompt data
  path.join(homedir, ".cursor"),
  path.join(homedir, ".claude"),
  path.join(homedir, ".codex"),
  path.join(homedir, ".gemini"),
]
export const PROTECTED_METADATA_PATH_NAMES = [".git", ".agents", ".codex", ".synergy"]

/**
 * Check if a target path would be denied write access because it falls inside
 * a protected metadata directory under any writable root.
 *
 * Mirrors Codex's `forbidden_agent_metadata_write()`.
 */
export function isMetadataWriteDenied(
  writableRoots: string[],
  targetPath: string,
  customProtectedNames?: string[],
): { denied: true; path: string; metadataName: string } | { denied: false } {
  const names = customProtectedNames ?? PROTECTED_METADATA_PATH_NAMES

  for (const root of writableRoots) {
    if (!targetPath.startsWith(root + "/") && targetPath !== root) continue
    for (const name of names) {
      const protectedFullPath = path.join(root, name)
      if (targetPath === protectedFullPath || targetPath.startsWith(protectedFullPath + "/")) {
        return { denied: true, path: targetPath, metadataName: name }
      }
    }
  }
  return { denied: false }
}

export const DEFAULT_PROTECTED_PATHS = (homedir: string, workspace: string): string[] => [
  path.join(workspace, ".git"),
  path.join(workspace, ".synergy"),
  ...CREDENTIAL_PATHS(homedir),
]
/**
 * Returns the subset of protectedPaths that fall under any writableRoot.
 *
 * These paths need explicit read-only subpath overrides because otherwise
 * they would be writable by virtue of being inside a writable root mount.
 */
export function protectedMetadataUnderWritableRoot(
  writableRoots: string[],
  protectedPaths: string[],
  workspace: string,
): string[] {
  return protectedPaths.filter((pp) => {
    const resolved = path.resolve(pp)
    return writableRoots.some((root) => {
      const resolvedRoot = path.resolve(root)
      return resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot
    })
  })
}

// ------------------------------------------------------------------
// ReadDenyMatcher — Runtime glob deny-read matching
// ------------------------------------------------------------------

/**
 * Escape a single character for use in a JavaScript regex.
 */
function escapeRegexChar(c: string): string {
  const specials = new Set([".", "+", "^", "$", "(", ")", "[", "]", "|", "\\"])
  return specials.has(c) ? "\\" + c : c
}

/**
 * Find the matching closing brace for a brace expansion starting at `start`.
 */
function findMatchingBrace(s: string, start: number): number {
  let depth = 1
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "{") depth++
    else if (s[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Split a brace expansion body on top-level commas, respecting nesting.
 */
function splitBraceAlternatives(s: string): string[] {
  const result: string[] = []
  let depth = 0
  let current = ""
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === "," && depth === 0) {
      result.push(current)
      current = ""
      continue
    }
    current += c
  }
  result.push(current)
  return result
}

/**
 * Compile the body of a glob (without anchors or depth prefix) into a regex fragment.
 */
function compileGlobFragment(glob: string): string {
  let result = ""
  let i = 0

  while (i < glob.length) {
    const c = glob[i]

    if (c === "*" && i + 1 < glob.length && glob[i + 1] === "*") {
      result += ".*"
      i += 2
      if (i < glob.length && glob[i] === "/") {
        result += "/"
        i += 1
      }
    } else if (c === "*") {
      result += "[^/]*"
      i += 1
    } else if (c === "?") {
      result += "[^/]"
      i += 1
    } else if (c === "{") {
      const closing = findMatchingBrace(glob, i)
      if (closing === -1) {
        result += escapeRegexChar(c)
        i += 1
        continue
      }
      const inner = glob.slice(i + 1, closing)
      const alternatives = splitBraceAlternatives(inner)
      const compiled = alternatives.map((a) => compileGlobFragment(a))
      result += "(" + compiled.join("|") + ")"
      i = closing + 1
    } else {
      result += escapeRegexChar(c)
      i += 1
    }
  }

  return result
}

/**
 * Compile a git-style glob pattern into a JavaScript RegExp.
 *
 * Glob semantics:
 *   **  → .*  (any directory depth including zero)
 *   *   → [^/]*  (single path component, non-slash)
 *   ?   → [^/]
 *   {a,b} → (a|b)
 *
 * Patterns that do not start with ** are prefixed with a directory-depth prefix to match
 * at any directory depth, consistent with gitignore default semantics.
 *
 * Returns null if compilation fails (invalid regex syntax).
 */
function compileGlobToRegex(glob: string): RegExp | null {
  try {
    const startsWithGlobstar = glob.startsWith("**")
    const body = compileGlobFragment(glob)
    const anchored = startsWithGlobstar ? body : "(.*/)?" + body
    return new RegExp("^" + anchored + "$")
  } catch {
    return null
  }
}

/**
 * Runtime matcher for deny-read rules.
 *
 * Combines exact-path rejection (unreadableRoots) with glob-pattern
 * rejection (unreadableGlobs). Designed for use in non-Seatbelt
 * sandbox backends (e.g. Windows) where kernel-level deny rules
 * are not available and must be enforced in-process.
 *
 * Fail-closed: if any glob fails to compile, all paths are denied.
 */
export class ReadDenyMatcher {
  private deniedCandidates: Set<string>
  private denyReadMatchers: RegExp[]
  private failedCompilation: boolean

  constructor(unreadableGlobs: string[], unreadableRoots: string[]) {
    this.deniedCandidates = new Set(unreadableRoots)
    this.denyReadMatchers = []
    this.failedCompilation = false

    for (const glob of unreadableGlobs) {
      const regex = compileGlobToRegex(glob)
      if (!regex) {
        this.failedCompilation = true
        break
      }
      this.denyReadMatchers.push(regex)
    }
  }

  /**
   * Check whether a path is denied for reading.
   * Returns true if the path matches any deny rule.
   * Fail-closed: returns true if any glob failed to compile.
   */
  isDenied(filepath: string): boolean {
    if (this.failedCompilation) return true
    if (this.deniedCandidates.has(filepath)) return true
    return this.denyReadMatchers.some((r) => r.test(filepath))
  }

  /**
   * Filter a batch of paths, returning only the denied subset.
   */
  isDeniedBatch(paths: string[]): string[] {
    return paths.filter((p) => this.isDenied(p))
  }
}
