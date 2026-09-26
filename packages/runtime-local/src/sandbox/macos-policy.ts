// ------------------------------------------------------------------
// macOS Seatbelt Policy Language (SBPL) profile generator
//
// Compiles a SynergySandboxPermissionProfile into a parameterized
// (deny default) sandbox-exec profile using SBPL constants from
// macos-sbpl.ts. Writable roots are parameterized via -D flags so the
// generated .sb file is portable across directories.
//
// Read model: file reads are allowed globally; only the credential
// paths in profile.fileSystem.readDenyPaths stay unreadable. Write
// containment is unchanged — writes are denied everywhere except the
// parameterized writable roots.
// ------------------------------------------------------------------
import * as fs_node from "fs"
import * as path_node from "path"

import type { SynergySandboxPermissionProfile } from "@ericsanchezok/synergy-harness/sandbox/policy-engine"
import { partitionDeniesByWritableRoot } from "@ericsanchezok/synergy-harness/sandbox/policy"
import { MacOSSbpl } from "./macos-sbpl"

// ------------------------------------------------------------------
// Parameter name helpers
// ------------------------------------------------------------------

function writeParamName(index: number): string {
  return `PATH_WRITE_${index}`
}

// ------------------------------------------------------------------
// Policy rule generators
// ------------------------------------------------------------------

function paramWriteRule(paramName: string): string {
  return `(allow file-read* file-write*
  (subpath (param "${paramName}")))`
}

function readOnlyDeny(subpath: string): string {
  return `(deny file-write* (subpath "${escapeSbpl(subpath)}"))`
}

function readDenyRule(denied: string): string {
  return `(deny file-read* (subpath "${escapeSbpl(denied)}"))`
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
 * `realpathSync` fails for a path that does not exist yet, which is the common
 * case for protected subpaths such as `<workspace>/.git/hooks` — the whole
 * point of denying them is that nothing has created them. Falling back to the
 * raw string would emit that deny in whatever spelling the caller used, while
 * the writable-root parameter is always bound through its canonical spelling.
 * The deny then covers a path the kernel never resolves and the deeper write
 * allow wins, so a firmlink alias (`/var/folders/...` for
 * `/private/var/folders/...`) escapes the protected subpath entirely.
 *
 * Resolving the nearest existing ancestor and re-appending the missing
 * components keeps every emitted rule in the kernel's spelling, whether or not
 * the target exists. Only a genuinely unresolvable path (no existing ancestor)
 * falls back to the input.
 */
function canonicalize(p: string): string {
  let existing = p
  const trailing: string[] = []
  for (;;) {
    try {
      const resolved = fs_node.realpathSync(existing)
      return trailing.length === 0 ? resolved : path_node.join(resolved, ...trailing)
    } catch {
      const parent = path_node.dirname(existing)
      if (parent === existing) return p
      trailing.unshift(path_node.basename(existing))
      existing = parent
    }
  }
}

// ------------------------------------------------------------------
// Main exports
export namespace MacOSPolicy {
  /**
   * Compile a SynergySandboxPermissionProfile into a complete SBPL
   * string suitable for sandbox-exec -f.
   *
   * Uses (deny default) as the base policy with parameterized writable
   * roots so the profile is portable. Reads are allowed globally and
   * denied only for the credential paths in readDenyPaths. A deny is
   * emitted on whichever side of the writable-root allow makes it
   * effective, because Seatbelt applies the last matching rule, not the
   * most specific one — see partitionDeniesByWritableRoot.
   *
   * Call generateParams() to produce the corresponding -D parameter map.
   */
  export function compileProfile(profile: SynergySandboxPermissionProfile): string {
    const lines: string[] = []
    const fs = profile.fileSystem

    // 1. Base policy
    lines.push(MacOSSbpl.DENY_DEFAULT_BASE)

    // 2. Platform defaults (process-exec, sysctl, IOKit, mach, etc.)
    lines.push(MacOSSbpl.PLATFORM_DEFAULTS)
    // Imported OS profiles may grant writes outside the requested roots (for example /cores).
    // Reset file writes, then grant only standard descriptors/devices and the compiled paths.
    lines.push("(deny file-write*)")
    lines.push(MacOSSbpl.DEVICE_WRITES)

    // 3. Global read allow — the read model is a deny list. A bare
    //    (allow file-read*) carries no path filter, so a subpath-scoped
    //    deny wins over it. Tool configs (e.g. ~/.config/gh), the developer
    //    toolchain, and arbitrary host paths stay readable without per-root
    //    enumeration.
    lines.push("(allow file-read*)")

    // 3a. Credential read denies placed before the writable-root allows: a
    //     deny CONTAINING a writable root must lose to the deeper allow, so a
    //     workspace nested inside a credential directory still works while its
    //     credential siblings stay denied. Canonicalized both because a
    //     missing path canonicalizes to itself (denying nothing that exists)
    //     and because the -D writable roots bind canonicalized spellings —
    //     comparing raw spellings could place a deny on the wrong side.
    const readDenies = partitionDeniesByWritableRoot(
      (fs.readDenyPaths ?? []).map(canonicalize),
      fs.writableRoots.map(canonicalize),
    )
    for (const denied of readDenies.beforeWritableRoots) {
      lines.push(readDenyRule(denied))
    }

    // 4. Writable roots — parameterized allow rules
    for (let i = 0; i < fs.writableRoots.length; i++) {
      lines.push(paramWriteRule(writeParamName(i)))
    }

    // 4a. Credential read denies inside a writable root, placed after the
    //     allow that would otherwise re-expose them. Rule order is the
    //     enforcement mechanism here, exactly as the Linux helper orders its
    //     cover mounts on both sides of the writable binds.
    for (const denied of readDenies.afterWritableRoots) {
      lines.push(readDenyRule(denied))
    }

    // 5. Read-only subpaths (protected paths inside writable roots)
    //    Canonicalize to handle APFS firmlink path remapping.
    for (const pp of fs.readOnlySubpaths) {
      lines.push(readOnlyDeny(canonicalize(pp)))
    }

    // 6. Network policy
    if (fs.includePlatformDefaults || fs.writableRoots.length === 0) {
      lines.push(MacOSSbpl.networkingPolicy(profile.network.mode))
    }

    // 7. Unix socket policy
    const unixSocketRules = MacOSSbpl.unixSocketPolicy(profile.network.allowedUnixSockets)
    if (unixSocketRules.length > 0) {
      lines.push(unixSocketRules)
    }

    // 7a. Protected metadata names — deny writes to critical dirs
    for (const name of fs.protectedMetadataNames) {
      // Skip empty strings
      if (name.length > 0) {
        lines.push(metadataDenyRegex(name))
      }
    }

    // 8. Unreadable globs — deny file-read* and file-read-data via compiled regex
    for (const glob of fs.unreadableGlobs) {
      const regex = compileGlobToSeatbeltRegex(glob)
      lines.push(`(deny file-read* (regex #"${regex}"))`)
      lines.push(`(deny file-read-data (regex #"${regex}"))`)
    }

    return lines.join("\n") + "\n"
  }

  export function compileExecution(profile: SynergySandboxPermissionProfile) {
    const params = generateParams(profile)
    return {
      profile: compileProfile(profile),
      params,
      writeFootprint: {
        kind: "roots" as const,
        roots: [...new Set([...Object.values(params), ...profile.network.allowedUnixSockets.map(canonicalize)])],
      },
    }
  }

  /**
   * Generate the -D parameter map for sandbox-exec.
   * Maps SBPL parameter names to the actual filesystem paths
   * they represent.
   */
  export function generateParams(profile: SynergySandboxPermissionProfile): Record<string, string> {
    const params: Record<string, string> = {}
    const fs = profile.fileSystem

    for (let i = 0; i < fs.writableRoots.length; i++) {
      params[writeParamName(i)] = canonicalize(fs.writableRoots[i])
    }

    return params
  }
}
