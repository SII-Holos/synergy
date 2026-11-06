import type {
  SynergySandboxPermissionProfile,
  SynergyFileSystemSandboxPolicy,
  SynergyNetworkSandboxPolicy,
  SandboxNetworkMode,
} from "../sandbox/policy-engine"

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

/** Network mode restrictiveness: higher index = more restrictive */
const NETWORK_RESTRICTIVENESS: Record<SandboxNetworkMode, number> = {
  full: 0,
  proxy_only: 1,
  restricted: 2,
}

/**
 * Returns the intersection of two permission profiles — only what is present in BOTH.
 *
 * - readableRoots / writableRoots / readOnlySubpaths → intersection (only paths in both)
 * - protectedPaths / dataDenyRoots / unreadableGlobs / protectedMetadataNames → union (both deny sets apply)
 * - network mode → most restrictive of the two
 * - allowLocalBinding → true only if both true
 * - allowedUnixSockets → intersection
 * - includePlatformDefaults → true only if both true
 * - workspace → from requested
 */
export function intersectProfiles(
  requested: SynergySandboxPermissionProfile,
  granted: SynergySandboxPermissionProfile,
): SynergySandboxPermissionProfile {
  const fileSystem: SynergyFileSystemSandboxPolicy = {
    readableRoots: intersectPaths(requested.fileSystem.readableRoots, granted.fileSystem.readableRoots),
    writableRoots: intersectPaths(requested.fileSystem.writableRoots, granted.fileSystem.writableRoots),
    readOnlySubpaths: intersectPaths(requested.fileSystem.readOnlySubpaths, granted.fileSystem.readOnlySubpaths),
    unreadableGlobs: unionPaths(requested.fileSystem.unreadableGlobs, granted.fileSystem.unreadableGlobs),
    protectedMetadataNames: unionPaths(
      requested.fileSystem.protectedMetadataNames,
      granted.fileSystem.protectedMetadataNames,
    ),
    protectedPaths: unionPaths(requested.fileSystem.protectedPaths, granted.fileSystem.protectedPaths),
    dataDenyRoots: unionPaths(requested.fileSystem.dataDenyRoots, granted.fileSystem.dataDenyRoots),
    includePlatformDefaults: requested.fileSystem.includePlatformDefaults && granted.fileSystem.includePlatformDefaults,
    workspace: requested.fileSystem.workspace,
  }

  const network: SynergyNetworkSandboxPolicy = {
    mode: mostRestrictiveMode(requested.network.mode, granted.network.mode),
    allowLocalBinding: requested.network.allowLocalBinding && granted.network.allowLocalBinding,
    allowedUnixSockets: intersectPaths(requested.network.allowedUnixSockets, granted.network.allowedUnixSockets),
  }

  return { fileSystem, network }
}

/**
 * Returns the union of two permission profiles — paths from both combined.
 *
 * - readableRoots / writableRoots / readOnlySubpaths → deduplicated union
 * - protectedPaths / dataDenyRoots / unreadableGlobs / protectedMetadataNames → union
 * - network mode → most permissive of the two ("full" if either is "full")
 * - allowLocalBinding → true if either is true
 * - allowedUnixSockets → deduplicated union
 * - includePlatformDefaults → true if either is true
 * - workspace → from base
 */
export function mergeProfiles(
  base: SynergySandboxPermissionProfile,
  additional: SynergySandboxPermissionProfile,
): SynergySandboxPermissionProfile {
  const fileSystem: SynergyFileSystemSandboxPolicy = {
    readableRoots: unionPaths(base.fileSystem.readableRoots, additional.fileSystem.readableRoots),
    writableRoots: unionPaths(base.fileSystem.writableRoots, additional.fileSystem.writableRoots),
    readOnlySubpaths: unionPaths(base.fileSystem.readOnlySubpaths, additional.fileSystem.readOnlySubpaths),
    unreadableGlobs: unionPaths(base.fileSystem.unreadableGlobs, additional.fileSystem.unreadableGlobs),
    protectedMetadataNames: unionPaths(
      base.fileSystem.protectedMetadataNames,
      additional.fileSystem.protectedMetadataNames,
    ),
    protectedPaths: unionPaths(base.fileSystem.protectedPaths, additional.fileSystem.protectedPaths),
    dataDenyRoots: unionPaths(base.fileSystem.dataDenyRoots, additional.fileSystem.dataDenyRoots),
    includePlatformDefaults: base.fileSystem.includePlatformDefaults || additional.fileSystem.includePlatformDefaults,
    workspace: base.fileSystem.workspace,
  }

  const network: SynergyNetworkSandboxPolicy = {
    mode: mostPermissiveMode(base.network.mode, additional.network.mode),
    allowLocalBinding: base.network.allowLocalBinding || additional.network.allowLocalBinding,
    allowedUnixSockets: unionPaths(base.network.allowedUnixSockets, additional.network.allowedUnixSockets),
  }

  return { fileSystem, network }
}

function intersectPaths(a: string[], b: string[]): string[] {
  const setB = new Set(b)
  return dedup(a.filter((p) => setB.has(p)))
}

function unionPaths(a: string[], b: string[]): string[] {
  return dedup([...a, ...b])
}

function mostRestrictiveMode(a: SandboxNetworkMode, b: SandboxNetworkMode): SandboxNetworkMode {
  return NETWORK_RESTRICTIVENESS[a] >= NETWORK_RESTRICTIVENESS[b] ? a : b
}

function mostPermissiveMode(a: SandboxNetworkMode, b: SandboxNetworkMode): SandboxNetworkMode {
  return NETWORK_RESTRICTIVENESS[a] <= NETWORK_RESTRICTIVENESS[b] ? a : b
}
