import { describe, test, expect } from "bun:test"
import { computeVersionDiffs, type VersionChangelogEntry } from "./changelog-utils"
import type { RegistryPluginVersion, RegistryPermissionItem } from "@ericsanchezok/synergy-sdk/client"

function version(
  overrides: Partial<Omit<RegistryPluginVersion, "version">> & { version: string },
): RegistryPluginVersion {
  return {
    manifestHash: "abc",
    permissionsHash: "def",
    integrity: "sha256:abc",
    risk: "low",
    permissionsSummary: [],
    publishedAt: 0,
    ...overrides,
  }
}

function perm(key: string, risk: "low" | "medium" | "high" = "low", description?: string): RegistryPermissionItem {
  return { key, description: description ?? `${key} permission`, risk }
}

describe("computeVersionDiffs", () => {
  test("empty array returns empty", () => {
    expect(computeVersionDiffs([])).toEqual([])
  })

  test("single version has all permissions as added", () => {
    const v1 = version({
      version: "1.0.0",
      permissionsSummary: [perm("tool.read", "low"), perm("file.write", "medium")],
      changelog: "Initial release",
      publishedAt: 1000,
      risk: "medium",
    })

    const result = computeVersionDiffs([v1])
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe("1.0.0")
    expect(result[0].added).toHaveLength(2)
    expect(result[0].removed).toHaveLength(0)
    expect(result[0].unchanged).toHaveLength(0)
    expect(result[0].changed).toHaveLength(0)
    expect(result[0].changelog).toBe("Initial release")
    expect(result[0].risk).toBe("medium")
    expect(result[0].publishedAt).toBe(1000)
  })

  test("second version adds new permissions, marks previous as unchanged", () => {
    const v1 = version({
      version: "1.0.0",
      permissionsSummary: [perm("tool.read", "low")],
      publishedAt: 1000,
    })
    const v2 = version({
      version: "1.1.0",
      permissionsSummary: [perm("tool.read", "low"), perm("network.connect", "high")],
      publishedAt: 2000,
      risk: "high",
      changelog: "Added network access",
    })

    const result = computeVersionDiffs([v1, v2])
    expect(result).toHaveLength(2)

    // v1: tool.read is added (first version)
    expect(result[0].added.map((p) => p.key)).toEqual(["tool.read"])
    expect(result[0].removed).toHaveLength(0)

    // v2: network.connect is added, tool.read is unchanged
    expect(result[1].added.map((p) => p.key)).toEqual(["network.connect"])
    expect(result[1].unchanged.map((p) => p.key)).toEqual(["tool.read"])
    expect(result[1].removed).toHaveLength(0)
    expect(result[1].changelog).toBe("Added network access")
    expect(result[1].risk).toBe("high")
  })

  test("version removes permissions from previous", () => {
    const v1 = version({
      version: "1.0.0",
      permissionsSummary: [perm("tool.read", "low"), perm("file.write", "medium")],
      publishedAt: 1000,
    })
    const v2 = version({
      version: "2.0.0",
      permissionsSummary: [perm("tool.read", "low")],
      publishedAt: 2000,
    })

    const result = computeVersionDiffs([v1, v2])
    expect(result[1].added).toHaveLength(0)
    expect(result[1].unchanged.map((p) => p.key)).toEqual(["tool.read"])
    expect(result[1].removed.map((p) => p.key)).toEqual(["file.write"])
  })

  test("version changes permission risk level", () => {
    const v1 = version({
      version: "1.0.0",
      permissionsSummary: [perm("tool.exec", "low")],
      publishedAt: 1000,
    })
    const v2 = version({
      version: "1.1.0",
      permissionsSummary: [perm("tool.exec", "high")],
      publishedAt: 2000,
    })

    const result = computeVersionDiffs([v1, v2])
    expect(result[1].added).toHaveLength(0)
    expect(result[1].removed).toHaveLength(0)
    expect(result[1].unchanged).toHaveLength(0)
    expect(result[1].changed).toHaveLength(1)
    expect(result[1].changed[0].key).toBe("tool.exec")
    expect(result[1].changed[0].before).toBe("low")
    expect(result[1].changed[0].after).toBe("high")
  })

  test("version with no permissionsSummary field", () => {
    const v1 = version({
      version: "1.0.0",
      permissionsSummary: [],
      publishedAt: 1000,
    })
    const v2 = version({
      version: "1.1.0",
      // permissionsSummary omitted
      permissionsSummary: [],
      publishedAt: 2000,
    })

    const result = computeVersionDiffs([v1, v2])
    expect(result[1].added).toHaveLength(0)
    expect(result[1].removed).toHaveLength(0)
  })

  test("sorts unsorted input by publishedAt", () => {
    const v1 = version({ version: "1.0.0", permissionsSummary: [perm("a", "low")], publishedAt: 1000 })
    const v2 = version({
      version: "2.0.0",
      permissionsSummary: [perm("a", "low"), perm("b", "low")],
      publishedAt: 2000,
    })
    const v3 = version({
      version: "1.5.0",
      permissionsSummary: [perm("a", "low"), perm("b", "low"), perm("c", "low")],
      publishedAt: 1500,
    })

    // Pass in reversed order
    const result = computeVersionDiffs([v3, v1, v2])
    expect(result.map((e) => e.version)).toEqual(["1.0.0", "1.5.0", "2.0.0"])
  })

  test("multiple versions track cumulative diff correctly", () => {
    const v1 = version({
      version: "1.0.0",
      permissionsSummary: [perm("a", "low"), perm("b", "low")],
      publishedAt: 1000,
    })
    const v2 = version({
      version: "1.1.0",
      permissionsSummary: [perm("a", "low"), perm("b", "low"), perm("c", "medium")],
      publishedAt: 2000,
    })
    const v3 = version({
      version: "2.0.0",
      permissionsSummary: [perm("a", "low"), perm("c", "high")],
      publishedAt: 3000,
    })

    const result = computeVersionDiffs([v1, v2, v3])

    // v1: a, b added
    expect(result[0].added.map((p) => p.key).sort()).toEqual(["a", "b"])

    // v2: c added; a, b unchanged
    expect(result[1].added.map((p) => p.key)).toEqual(["c"])
    expect(result[1].unchanged.map((p) => p.key).sort()).toEqual(["a", "b"])

    // v3: b removed; c risk changed low→high; a unchanged
    expect(result[2].added).toHaveLength(0)
    expect(result[2].removed.map((p) => p.key)).toEqual(["b"])
    expect(result[2].unchanged.map((p) => p.key)).toEqual(["a"])
    expect(result[2].changed.map((c) => ({ key: c.key, before: c.before, after: c.after }))).toEqual([
      { key: "c", before: "medium", after: "high" },
    ])
  })

  test("changelog field is optional and defaults to undefined", () => {
    const v1 = version({ version: "1.0.0", permissionsSummary: [perm("a", "low")], publishedAt: 1000 })
    const result = computeVersionDiffs([v1])
    expect(result[0].changelog).toBeUndefined()
  })
})
