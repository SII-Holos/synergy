import { test, expect } from "bun:test"
import { intersectProfiles, mergeProfiles } from "../../src/permission/intersect"
import type {
  SynergySandboxPermissionProfile,
  SynergyFileSystemSandboxPolicy,
  SynergyNetworkSandboxPolicy,
  SandboxNetworkMode,
} from "../../src/sandbox/policy-engine"

type FsPartial = Partial<SynergyFileSystemSandboxPolicy>
type NetPartial = Partial<SynergyNetworkSandboxPolicy>
type ProfileOverrides = { fileSystem?: FsPartial; network?: NetPartial }

function fsProfile(overrides: ProfileOverrides = {}): SynergySandboxPermissionProfile {
  return {
    fileSystem: {
      readableRoots: [],
      writableRoots: [],
      readOnlySubpaths: [],
      unreadableGlobs: [],
      protectedMetadataNames: [],
      protectedPaths: [],
      dataDenyRoots: [],
      includePlatformDefaults: true,
      workspace: "/tmp/workspace",
      ...overrides.fileSystem,
    },
    network: {
      mode: "full" as SandboxNetworkMode,
      allowLocalBinding: true,
      allowedUnixSockets: [],
      ...overrides.network,
    },
  }
}

function ra(...paths: string[]): ProfileOverrides {
  return { fileSystem: { readableRoots: paths } }
}
function wa(...paths: string[]): ProfileOverrides {
  return { fileSystem: { writableRoots: paths } }
}
function ro(...paths: string[]): ProfileOverrides {
  return { fileSystem: { readOnlySubpaths: paths } }
}
function pr(...paths: string[]): ProfileOverrides {
  return { fileSystem: { protectedPaths: paths } }
}
function dd(...paths: string[]): ProfileOverrides {
  return { fileSystem: { dataDenyRoots: paths } }
}
function ug(...globs: string[]): ProfileOverrides {
  return { fileSystem: { unreadableGlobs: globs } }
}
function pm(...names: string[]): ProfileOverrides {
  return { fileSystem: { protectedMetadataNames: names } }
}
function net(mode: "full" | "restricted" | "proxy_only", binding = false, sockets: string[] = []): ProfileOverrides {
  return { network: { mode, allowLocalBinding: binding, allowedUnixSockets: sockets } }
}

function profile(...overrides: ProfileOverrides[]): SynergySandboxPermissionProfile {
  let base = fsProfile()
  for (const o of overrides) {
    base = {
      fileSystem: { ...base.fileSystem, ...o.fileSystem },
      network: { ...base.network, ...o.network },
    } as SynergySandboxPermissionProfile
  }
  return base
}

// ── intersectProfiles: readableRoots ──

test("intersect - readableRoots intersection (shared paths only)", () => {
  const result = intersectProfiles(profile(ra("/a", "/b", "/c")), profile(ra("/b", "/c", "/d")))
  expect(result.fileSystem.readableRoots.sort()).toEqual(["/b", "/c"].sort())
})

test("intersect - readableRoots empty when no overlap", () => {
  const result = intersectProfiles(profile(ra("/a")), profile(ra("/b")))
  expect(result.fileSystem.readableRoots).toEqual([])
})

test("intersect - readableRoots deduplicates", () => {
  const result = intersectProfiles(profile(ra("/a", "/a")), profile(ra("/a")))
  expect(result.fileSystem.readableRoots).toEqual(["/a"])
})

// ── intersectProfiles: writableRoots ──

test("intersect - writableRoots intersection", () => {
  const result = intersectProfiles(profile(wa("/a", "/b")), profile(wa("/b", "/c")))
  expect(result.fileSystem.writableRoots.sort()).toEqual(["/b"].sort())
})

test("intersect - writableRoots empty when no overlap", () => {
  const result = intersectProfiles(profile(wa("/a")), profile(wa("/b")))
  expect(result.fileSystem.writableRoots).toEqual([])
})

// ── intersectProfiles: readOnlySubpaths ──

test("intersect - readOnlySubpaths intersection", () => {
  const result = intersectProfiles(profile(ro("/a/.git", "/a/.synergy")), profile(ro("/a/.git")))
  expect(result.fileSystem.readOnlySubpaths).toEqual(["/a/.git"])
})

// ── intersectProfiles: deny sets → union ──

test("intersect - dataDenyRoots union (both apply)", () => {
  const result = intersectProfiles(profile(dd("/home", "/tmp")), profile(dd("/var", "/home")))
  expect(result.fileSystem.dataDenyRoots.sort()).toEqual(["/home", "/tmp", "/var"].sort())
})

test("intersect - protectedPaths union", () => {
  const result = intersectProfiles(profile(pr("/etc/passwd")), profile(pr("/etc/shadow")))
  expect(result.fileSystem.protectedPaths.sort()).toEqual(["/etc/passwd", "/etc/shadow"].sort())
})

test("intersect - unreadableGlobs union", () => {
  const result = intersectProfiles(profile(ug("*.env", "*.key")), profile(ug("*.key", "*.pem")))
  expect(result.fileSystem.unreadableGlobs.sort()).toEqual(["*.env", "*.key", "*.pem"].sort())
})

test("intersect - protectedMetadataNames union", () => {
  const result = intersectProfiles(profile(pm(".git", ".synergy")), profile(pm(".codex", ".synergy")))
  expect(result.fileSystem.protectedMetadataNames.sort()).toEqual([".codex", ".git", ".synergy"].sort())
})

// ── intersectProfiles: network ──

test("intersect - network mode: most restrictive wins", () => {
  const result = intersectProfiles(profile(net("full")), profile(net("restricted")))
  expect(result.network.mode).toBe("restricted")
})

test("intersect - network mode: restricted vs proxy_only → restricted", () => {
  const result = intersectProfiles(profile(net("restricted")), profile(net("proxy_only")))
  expect(result.network.mode).toBe("restricted")
})

test("intersect - network mode: full vs full → full", () => {
  const result = intersectProfiles(profile(net("full")), profile(net("full")))
  expect(result.network.mode).toBe("full")
})

test("intersect - allowLocalBinding true only if both true", () => {
  expect(intersectProfiles(profile(net("full", true)), profile(net("full", true))).network.allowLocalBinding).toBe(true)
  expect(intersectProfiles(profile(net("full", true)), profile(net("full", false))).network.allowLocalBinding).toBe(
    false,
  )
  expect(intersectProfiles(profile(net("full", false)), profile(net("full", false))).network.allowLocalBinding).toBe(
    false,
  )
})

test("intersect - allowedUnixSockets intersection", () => {
  const result = intersectProfiles(
    profile(net("full", true, ["/tmp/sock1", "/tmp/sock2"])),
    profile(net("full", true, ["/tmp/sock2", "/tmp/sock3"])),
  )
  expect(result.network.allowedUnixSockets).toEqual(["/tmp/sock2"])
})

// ── intersectProfiles: includePlatformDefaults ──

test("intersect - includePlatformDefaults true only if both true", () => {
  const a = fsProfile({ fileSystem: { includePlatformDefaults: true } })
  const b = fsProfile({ fileSystem: { includePlatformDefaults: false } })
  expect(intersectProfiles(a, b).fileSystem.includePlatformDefaults).toBe(false)
  expect(intersectProfiles(a, a).fileSystem.includePlatformDefaults).toBe(true)
})

// ── intersectProfiles: workspace ──

test("intersect - workspace comes from requested", () => {
  const result = intersectProfiles(
    fsProfile({ fileSystem: { workspace: "/req" } }),
    fsProfile({ fileSystem: { workspace: "/grant" } }),
  )
  expect(result.fileSystem.workspace).toBe("/req")
})

// ── mergeProfiles: readableRoots ──

test("merge - readableRoots deduplicated union", () => {
  const result = mergeProfiles(profile(ra("/a", "/b")), profile(ra("/b", "/c")))
  expect(result.fileSystem.readableRoots.sort()).toEqual(["/a", "/b", "/c"].sort())
})

test("merge - readableRoots handles empty arrays", () => {
  const result = mergeProfiles(profile(ra()), profile(ra("/a")))
  expect(result.fileSystem.readableRoots).toEqual(["/a"])
})

// ── mergeProfiles: writableRoots ──

test("merge - writableRoots deduplicated union", () => {
  const result = mergeProfiles(profile(wa("/a")), profile(wa("/b")))
  expect(result.fileSystem.writableRoots.sort()).toEqual(["/a", "/b"].sort())
})

test("merge - writableRoots deduplicates overlap", () => {
  const result = mergeProfiles(profile(wa("/a", "/b")), profile(wa("/b", "/c")))
  expect(result.fileSystem.writableRoots.sort()).toEqual(["/a", "/b", "/c"].sort())
})

// ── mergeProfiles: readOnlySubpaths ──

test("merge - readOnlySubpaths deduplicated union", () => {
  const result = mergeProfiles(profile(ro("/a/.git")), profile(ro("/b/.git")))
  expect(result.fileSystem.readOnlySubpaths.sort()).toEqual(["/a/.git", "/b/.git"].sort())
})

// ── mergeProfiles: deny sets → union ──

test("merge - dataDenyRoots union", () => {
  const result = mergeProfiles(profile(dd("/home")), profile(dd("/var")))
  expect(result.fileSystem.dataDenyRoots.sort()).toEqual(["/home", "/var"].sort())
})

test("merge - protectedPaths union", () => {
  const result = mergeProfiles(profile(pr("/etc/passwd")), profile(pr("/etc/shadow")))
  expect(result.fileSystem.protectedPaths.sort()).toEqual(["/etc/passwd", "/etc/shadow"].sort())
})

test("merge - unreadableGlobs union", () => {
  const result = mergeProfiles(profile(ug("*.env")), profile(ug("*.secret")))
  expect(result.fileSystem.unreadableGlobs.sort()).toEqual(["*.env", "*.secret"].sort())
})

test("merge - protectedMetadataNames union", () => {
  const result = mergeProfiles(profile(pm(".git")), profile(pm(".synergy")))
  expect(result.fileSystem.protectedMetadataNames.sort()).toEqual([".git", ".synergy"].sort())
})

// ── mergeProfiles: network ──

test("merge - network mode: full if either is full", () => {
  expect(mergeProfiles(profile(net("full")), profile(net("restricted"))).network.mode).toBe("full")
  expect(mergeProfiles(profile(net("restricted")), profile(net("full"))).network.mode).toBe("full")
  expect(mergeProfiles(profile(net("restricted")), profile(net("proxy_only"))).network.mode).toBe("proxy_only")
})

test("merge - allowLocalBinding true if either is true", () => {
  expect(mergeProfiles(profile(net("full", true)), profile(net("full", false))).network.allowLocalBinding).toBe(true)
  expect(mergeProfiles(profile(net("full", false)), profile(net("full", true))).network.allowLocalBinding).toBe(true)
  expect(mergeProfiles(profile(net("full", false)), profile(net("full", false))).network.allowLocalBinding).toBe(false)
})

test("merge - allowedUnixSockets deduplicated union", () => {
  const result = mergeProfiles(
    profile(net("full", true, ["/tmp/a", "/tmp/b"])),
    profile(net("full", true, ["/tmp/b", "/tmp/c"])),
  )
  expect(result.network.allowedUnixSockets.sort()).toEqual(["/tmp/a", "/tmp/b", "/tmp/c"].sort())
})

// ── mergeProfiles: includePlatformDefaults ──

test("merge - includePlatformDefaults true if either is true", () => {
  const a = fsProfile({ fileSystem: { includePlatformDefaults: true } })
  const b = fsProfile({ fileSystem: { includePlatformDefaults: false } })
  expect(mergeProfiles(a, b).fileSystem.includePlatformDefaults).toBe(true)
  expect(mergeProfiles(b, a).fileSystem.includePlatformDefaults).toBe(true)
  expect(mergeProfiles(b, b).fileSystem.includePlatformDefaults).toBe(false)
})

// ── mergeProfiles: workspace ──

test("merge - workspace comes from base", () => {
  const result = mergeProfiles(
    fsProfile({ fileSystem: { workspace: "/base" } }),
    fsProfile({ fileSystem: { workspace: "/additional" } }),
  )
  expect(result.fileSystem.workspace).toBe("/base")
})

// ── Preserve all fields through the pipeline ──

test("intersect - preserves all fields in result", () => {
  const result = intersectProfiles(fsProfile(), fsProfile())
  expect(result).toHaveProperty("fileSystem")
  expect(result).toHaveProperty("network")
  expect(result.fileSystem).toHaveProperty("readableRoots")
  expect(result.fileSystem).toHaveProperty("writableRoots")
  expect(result.fileSystem).toHaveProperty("readOnlySubpaths")
  expect(result.fileSystem).toHaveProperty("unreadableGlobs")
  expect(result.fileSystem).toHaveProperty("protectedMetadataNames")
  expect(result.fileSystem).toHaveProperty("protectedPaths")
  expect(result.fileSystem).toHaveProperty("dataDenyRoots")
  expect(result.fileSystem).toHaveProperty("includePlatformDefaults")
  expect(result.fileSystem).toHaveProperty("workspace")
  expect(result.network).toHaveProperty("mode")
  expect(result.network).toHaveProperty("allowLocalBinding")
  expect(result.network).toHaveProperty("allowedUnixSockets")
})

// ── Round-trip: intersect then merge is not lossless ──

test("round-trip - merge after intersect does not restore lost paths", () => {
  const requested = profile(ra("/a", "/b"), wa("/a"))
  const granted = profile(ra("/b", "/c"), wa("/b"))

  const intersected = intersectProfiles(requested, granted)

  // Merging intersected back with requested: should NOT bring back "/a" (or "/b" is already there, "/c")
  const merged = mergeProfiles(intersected, requested)
  // Intersected has /b, requested has /a, /b → union = [/b, /a]
  expect(merged.fileSystem.readableRoots.sort()).toEqual(["/a", "/b"].sort())
})

test("semantic - intersect produces a profile that is at most as permissive as either input", () => {
  const a = profile(ra("/x", "/y"))
  const b = profile(ra("/y", "/z"))
  const result = intersectProfiles(a, b)
  for (const r of result.fileSystem.readableRoots) {
    expect(a.fileSystem.readableRoots).toContain(r)
    expect(b.fileSystem.readableRoots).toContain(r)
  }
})

test("semantic - merge produces a profile that is at least as permissive as either input", () => {
  const a = profile(ra("/x"))
  const b = profile(ra("/y"))
  const result = mergeProfiles(a, b)
  for (const r of a.fileSystem.readableRoots) {
    expect(result.fileSystem.readableRoots).toContain(r)
  }
  for (const r of b.fileSystem.readableRoots) {
    expect(result.fileSystem.readableRoots).toContain(r)
  }
})
