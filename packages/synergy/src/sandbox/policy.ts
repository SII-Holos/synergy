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

export const DEFAULT_PROTECTED_PATHS = (homedir: string, workspace: string): string[] => [
  path.join(workspace, ".git"),
  path.join(workspace, ".synergy"),
  ...CREDENTIAL_PATHS(homedir),
]
