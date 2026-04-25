import path from "path"

export namespace PluginSpec {
  /** Regex matching non-registry package spec prefixes (github:, git+, etc.). */
  export const NON_REGISTRY_RE = /^(github:|git\+|git:\/\/|https?:\/\/|ssh:\/\/)/

  /** Whether a spec string refers to a non-registry source (git, URL, etc.). */
  export function isNonRegistry(spec: string): boolean {
    return NON_REGISTRY_RE.test(spec)
  }

  export interface Parsed {
    pkg: string
    version: string
    nonRegistry: boolean
  }

  /**
   * Parse a plugin path spec into { pkg, version, nonRegistry }.
   *
   * For non-registry specs (github:, git+ssh:, etc.) the entire string is
   * the package spec — no @ splitting because URLs contain @ in userinfo.
   * For registry packages, split on the last @ to separate name and version.
   */
  export function parse(spec: string): Parsed {
    const nonRegistry = isNonRegistry(spec)
    if (nonRegistry) {
      return { pkg: spec, version: "latest", nonRegistry: true }
    }
    const lastAtIndex = spec.lastIndexOf("@")
    if (lastAtIndex > 0) {
      return { pkg: spec.substring(0, lastAtIndex), version: spec.substring(lastAtIndex + 1), nonRegistry: false }
    }
    return { pkg: spec, version: "latest", nonRegistry: false }
  }

  /** Derive a short display name from a plugin path spec. */
  export function displayName(spec: string): string {
    if (spec.startsWith("file://")) {
      return path.basename(spec.slice("file://".length))
    }
    const last = spec.split("/").pop() ?? spec
    const atIdx = last.lastIndexOf("@")
    return atIdx > 0 ? last.substring(0, atIdx) : last
  }
}
