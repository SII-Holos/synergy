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

export const DEFAULT_PROTECTED_PATHS = (homedir: string, workspace: string): string[] => [
  path.join(workspace, ".git"),
  path.join(homedir, ".synergy", "config"),
  path.join(homedir, ".synergy", "data", "auth", "api-key.json"),
]
