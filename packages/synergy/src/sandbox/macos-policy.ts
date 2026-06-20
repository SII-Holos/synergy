// ------------------------------------------------------------------
// macOS Seatbelt Policy Language (SBPL) profile generator
//
// Compiles a SynergySandboxPermissionProfile into a parameterized
// (deny default) sandbox-exec profile using SBPL constants from
// macos-sbpl.ts. Paths are parameterized via -D flags so the
// generated .sb file is portable across directories.
// ------------------------------------------------------------------
import * as fs_node from "fs"
import * as os from "os"
import * as path from "path"
import { ancestorLiterals } from "./policy"

import type { SynergySandboxPermissionProfile } from "./policy-engine"
import { MacOSSbpl } from "./macos-sbpl"

// ------------------------------------------------------------------
// Parameter name helpers
// ------------------------------------------------------------------

function readParamName(index: number): string {
  return `PATH_READ_${index}`
}

function writeParamName(index: number): string {
  return `PATH_WRITE_${index}`
}

// ------------------------------------------------------------------
// Policy rule generators
// ------------------------------------------------------------------

function paramReadRule(paramName: string): string {
  return `(allow file-read*
  (param "${paramName}")
  (subpath (param "${paramName}")))`
}

function paramWriteRule(paramName: string): string {
  return `(allow file-read* file-write*
  (param "${paramName}")
  (subpath (param "${paramName}")))`
}

function readOnlyDeny(subpath: string): string {
  return `(deny file-write* (subpath "${escapeSbpl(subpath)}"))`
}

function metadataDenyRegex(name: string): string {
  // Protect writable paths containing /.<name>/ or ending in /.<name>
  const escaped = name.replace(/\./g, "\\.")
  return `(deny file-write*
  (regex #"/${escaped}/")
  (regex #"/${escaped}$"))`
}

/**
 * Escape SBPL string literal content.
 * Backslash and double-quote are the significant escapes inside SBPL strings.
 */
function escapeSbpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
// ------------------------------------------------------------------
// Glob → Seatbelt regex compilation
// ------------------------------------------------------------------

/**
 * Escape a single character for use in an SBPL regex.
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
 * e.g. "a,b,{c,d}" → ["a", "b", "{c,d}"]
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
 * Compile a git-style glob pattern into a Seatbelt-compatible regex string.
 *
 * Glob semantics:
 *   **  → .*  (any directory depth including zero)
 *   *   → [^/]*  (single path component, non-slash)
 *   ?   → [^/]
 *   {a,b} → (a|b)
 *
 * Patterns that do not start with ** are prefixed with (.\x2a/)? to match
 * at any directory depth, consistent with gitignore default semantics.
 */
export function compileGlobToSeatbeltRegex(glob: string): string {
  const startsWithGlobstar = glob.startsWith("**")
  const body = compileGlobBody(glob)
  const anchored = startsWithGlobstar ? body : "(.*/)?" + body
  return "^" + anchored + "$"
}

/**
 * Compile the body of a glob (without anchors or depth prefix).
 */
function compileGlobBody(glob: string): string {
  let result = ""
  let i = 0

  while (i < glob.length) {
    const c = glob[i]

    if (c === "*" && i + 1 < glob.length && glob[i + 1] === "*") {
      // ** — any directory depth
      result += ".*"
      i += 2
      // If ** is followed by /, consume it — .* already covers the /
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
        // Unbalanced brace — treat as literal
        result += escapeRegexChar(c)
        i += 1
        continue
      }
      const inner = glob.slice(i + 1, closing)
      const alternatives = splitBraceAlternatives(inner)
      const compiled = alternatives.map((a) => compileGlobBody(a))
      result += "(" + compiled.join("|") + ")"
      i = closing + 1
    } else {
      result += escapeRegexChar(c)
      i += 1
    }
  }

  return result
}

// ------------------------------------------------------------------
// Path normalization helpers
// ------------------------------------------------------------------

/**
 * Canonicalize a path through realpath to handle APFS firmlinks.
 * On macOS, /tmp → /private/tmp and /Users → /System/Volumes/Data/Users.
 * SBPL rules using user-visible paths may not match kernel-resolved paths,
 * so we resolve all paths to their canonical form before Rule generation.
 *
 * Returns the original path if realpath fails (e.g. path doesn't exist yet).
 */
function canonicalize(p: string): string {
  try {
    return fs_node.realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Build deny rules for sibling directories of the workspace in the homedir.
 *
 * Seatbelt SBPL enforces "deny always wins" regardless of rule order.
 * A broad (deny (subpath /Users/eric)) would block workspace access even if
 * the workspace is later allowed. Instead, we enumerate each sibling directory
 * of the homedir and deny only those that are NOT the workspace or its ancestors.
 *
 * This achieves the goal: workspace access is permitted, but other user data
 * directories under $HOME are blocked.
 */
function buildSiblingDenyRules(workspace: string, homedir: string): string[] {
  const results: string[] = []
  const ancestors = new Set(ancestorLiterals(workspace).map((p) => canonicalize(p)))

  try {
    const entries = fs_node.readdirSync(homedir)
    for (const entry of entries) {
      const full = canonicalize(path.join(homedir, entry))
      if (!ancestors.has(full) && !full.startsWith(workspace + "/") && full !== workspace) {
        const r = escapeSbpl(full)
        results.push(`(deny file-read* (subpath "${r}"))`)
        results.push(`(deny file-write* (subpath "${r}"))`)
      }
    }
  } catch {
    // can't read homedir — skip sibling blocking
  }

  return results
}

// ------------------------------------------------------------------
// Main exports
export namespace MacOSPolicy {
  /**
   * Compile a SynergySandboxPermissionProfile into a complete SBPL
   * string suitable for sandbox-exec -f.
   *
   * Uses (deny default) as the base policy with parameterized path
   * variables so the profile is portable. Call generateParams() to
   * produce the corresponding -D parameter map.
   */
  export function compileProfile(profile: SynergySandboxPermissionProfile): string {
    const lines: string[] = []
    const fs = profile.fileSystem

    // 1. Base policy
    lines.push(MacOSSbpl.DENY_DEFAULT_BASE)

    // 2. Platform defaults (process-exec, sysctl, IOKit, mach, etc.)
    lines.push(MacOSSbpl.PLATFORM_DEFAULTS)

    // 3. Readable roots — parameterized allow rules
    for (let i = 0; i < fs.readableRoots.length; i++) {
      lines.push(paramReadRule(readParamName(i)))
    }

    // 4. Writable roots — parameterized allow rules
    for (let i = 0; i < fs.writableRoots.length; i++) {
      lines.push(paramWriteRule(writeParamName(i)))
    }

    // 5. Read-only subpaths (protected paths inside writable roots)
    //    Canonicalize to handle APFS firmlink path remapping.
    for (const pp of fs.readOnlySubpaths) {
      lines.push(readOnlyDeny(canonicalize(pp)))
    }

    // 6. Sibling-block deny rules — block homedir children except workspace
    //    Uses canonicalized paths for APFS firmlink correctness.
    const homedir = canonicalize(os.homedir())
    const workspace = canonicalize(fs.workspace)
    for (const rule of buildSiblingDenyRules(workspace, homedir)) {
      lines.push(rule)
    }

    // 7. Network policy
    if (fs.includePlatformDefaults || fs.writableRoots.length === 0) {
      lines.push(MacOSSbpl.networkingPolicy(profile.network.mode))
    }

    // 8. Protected metadata names — deny writes to critical dirs
    for (const name of fs.protectedMetadataNames) {
      // Skip empty strings
      if (name.length > 0) {
        lines.push(metadataDenyRegex(name))
      }
    }

    // 9. Unreadable globs — deny file-read* and file-read-data via compiled regex
    for (const glob of fs.unreadableGlobs) {
      const regex = compileGlobToSeatbeltRegex(glob)
      lines.push(`(deny file-read* (regex #"${regex}"))`)
      lines.push(`(deny file-read-data (regex #"${regex}"))`)
    }

    return lines.join("\n") + "\n"
  }

  /**
   * Generate the -D parameter map for sandbox-exec.
   * Maps SBPL parameter names to the actual filesystem paths
   * they represent.
   */
  export function generateParams(profile: SynergySandboxPermissionProfile): Record<string, string> {
    const params: Record<string, string> = {}
    const fs = profile.fileSystem

    for (let i = 0; i < fs.readableRoots.length; i++) {
      params[readParamName(i)] = canonicalize(fs.readableRoots[i])
    }

    for (let i = 0; i < fs.writableRoots.length; i++) {
      params[writeParamName(i)] = canonicalize(fs.writableRoots[i])
    }

    return params
  }
}
