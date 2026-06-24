/**
 * Cross-platform path normalisation utilities.
 *
 * Synergy stores paths in canonical forward-slash form internally,
 * following the industry standard (TypeScript compiler, Vite, Deno, esbuild).
 * Both '/' and '\' are accepted as input.
 *
 * All string operations that inspect or split paths MUST use these
 * constants instead of bare '/' string literals.
 */
import { sep } from "node:path"

/** Canonical internal path separator (forward slash, Unix-style) */
export const sepCanonical = "/"

/** Alternative path separator accepted as input (backslash, Windows) */
export const sepAlt = "\\"

const backslashRe = /\\/g

/**
 * Normalise all path separators to canonical forward slashes.
 *
 * Apply this at every boundary where a path enters the system:
 * glob results, config values, CLI arguments, user input, HTTP params.
 * After normalisation, all path comparisons and string operations
 * can safely use `/`.
 */
export function normalizeSlashes(p: string): string {
  return p.includes("\\") ? p.replace(backslashRe, sepCanonical) : p
}

/**
 * Check whether a character code is any recognised path separator.
 * Accepts both '/' (47) and '\' (92).
 */
export function isPathSeparator(code: number): boolean {
  return code === 47 || code === 92
}

/**
 * Convert a canonical (forward-slash) path back to the platform-native
 * form. Use this only when building paths for external consumption
 * (shell commands, error messages for native tooling).
 */
export function toPlatformPath(p: string): string {
  return sep === sepCanonical ? p : p.replaceAll(sepCanonical, sep)
}
