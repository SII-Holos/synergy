import { describe, expect, test } from "bun:test"
import { computeVersionDiffs } from "../../../src/plugin/marketplace/changelog-utils"
import type { RegistryPermissionItem, RegistryPluginVersion } from "@ericsanchezok/synergy-sdk/client"

function permission(key: string): RegistryPermissionItem {
  return { key, description: `${key} permission` }
}

function version(
  name: string,
  publishedAt: number,
  permissionsSummary: RegistryPermissionItem[],
): RegistryPluginVersion {
  return {
    version: name,
    manifestHash: "manifest",
    permissionsHash: "permissions",
    featuresSummary: [],
    permissionsSummary,
    publishedAt,
  }
}

describe("computeVersionDiffs", () => {
  test("returns no entries for an empty history", () => {
    expect(computeVersionDiffs([])).toEqual([])
  })

  test("sorts versions and reports access additions, removals, and unchanged entries", () => {
    const first = version("1.0.0", 1_000, [permission("a"), permission("b")])
    const second = version("1.1.0", 2_000, [permission("a"), permission("c")])
    const result = computeVersionDiffs([second, first])

    expect(result.map((entry) => entry.version)).toEqual(["1.0.0", "1.1.0"])
    expect(result[0]!.added.map((item) => item.key)).toEqual(["a", "b"])
    expect(result[1]!.added.map((item) => item.key)).toEqual(["c"])
    expect(result[1]!.removed.map((item) => item.key)).toEqual(["b"])
    expect(result[1]!.unchanged.map((item) => item.key)).toEqual(["a"])
  })

  test("preserves author changelog without inventing risk metadata", () => {
    const input = { ...version("2.0.0", 3_000, []), changelog: "Faster startup" }
    expect(computeVersionDiffs([input])[0]).toMatchObject({
      version: "2.0.0",
      changelog: "Faster startup",
    })
    expect(computeVersionDiffs([input])[0]).not.toHaveProperty("risk")
  })
})
