// ------------------------------------------------------------------
// macOS Seatbelt Policy Language (SBPL) profile generator
//
// Compiles a SynergySandboxPermissionProfile into a parameterized
// (deny default) sandbox-exec profile using SBPL constants from
// macos-sbpl.ts. Paths are parameterized via -D flags so the
// generated .sb file is portable across directories.
// ------------------------------------------------------------------

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

function dataDenyRule(root: string): string {
  const r = escapeSbpl(root)
  return `(deny file-read* (subpath "${r}"))
(deny file-write* (subpath "${r}"))`
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
// Main exports
// ------------------------------------------------------------------

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
    for (const pp of fs.readOnlySubpaths) {
      lines.push(readOnlyDeny(pp))
    }

    // 6. Data deny roots (e.g. homedir — deny all access)
    for (const root of fs.dataDenyRoots) {
      lines.push(dataDenyRule(root))
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
      params[readParamName(i)] = fs.readableRoots[i]
    }

    for (let i = 0; i < fs.writableRoots.length; i++) {
      params[writeParamName(i)] = fs.writableRoots[i]
    }

    return params
  }
}
