import { describe, expect, test } from "bun:test"
import {
  type PluginApprovalRecord,
  computeManifestHash,
  computePermissionsHash,
  verifyApproval,
  readApprovals,
  writeApprovals,
  getApproval,
  saveApproval,
  removeApproval,
} from "../../src/plugin/consent/approval-store"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"

// ---------------------------------------------------------------------------
// Test helper: build a minimal manifest
// ---------------------------------------------------------------------------

function minimalManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return PluginManifest.parse({
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Hash determinism tests
// ---------------------------------------------------------------------------

describe("computeManifestHash", () => {
  test("produces same hash for identical manifests", () => {
    const a = minimalManifest()
    const b = minimalManifest()
    expect(computeManifestHash(a)).toBe(computeManifestHash(b))
  })

  test("produces same hash regardless of json key ordering", () => {
    // Build two manifests with identical fields but different key orders.
    // We can't control key order in parsed objects, so we verify that
    // two separately constructed manifests with same content match.
    const a = minimalManifest()
    const b = PluginManifest.parse({
      version: "1.0.0",
      description: "A test plugin",
      name: "test-plugin",
    })
    expect(computeManifestHash(a)).toBe(computeManifestHash(b))
  })

  test("differs when name changes", () => {
    const a = minimalManifest()
    const b = minimalManifest({ name: "other-plugin" })
    expect(computeManifestHash(a)).not.toBe(computeManifestHash(b))
  })

  test("differs when version changes", () => {
    const a = minimalManifest()
    const b = minimalManifest({ version: "2.0.0" })
    expect(computeManifestHash(a)).not.toBe(computeManifestHash(b))
  })

  test("differs when description changes", () => {
    const a = minimalManifest()
    const b = minimalManifest({ description: "A different description" })
    expect(computeManifestHash(a)).not.toBe(computeManifestHash(b))
  })

  test("differs when declarative contributions change", () => {
    const a = minimalManifest({
      contributes: {
        skills: [{ name: "docs", description: "Read docs", dir: "./skills/docs" }],
      },
    })
    const b = minimalManifest({
      contributes: {
        skills: [{ name: "docs", description: "Read current docs", dir: "./skills/docs" }],
      },
    })
    expect(computeManifestHash(a)).not.toBe(computeManifestHash(b))
  })

  test("is stable (does not change on repeated calls)", () => {
    const m = minimalManifest()
    const h1 = computeManifestHash(m)
    const h2 = computeManifestHash(m)
    const h3 = computeManifestHash(m)
    expect(h1).toBe(h2)
    expect(h2).toBe(h3)
  })
})

describe("computePermissionsHash", () => {
  test("produces same hash for identical permissions and capabilities", () => {
    const m = minimalManifest({
      permissions: {
        tools: { filesystem: "write", network: true, shell: false, mcp: "none" },
      },
    })
    const caps = ["execute", "read"]
    expect(computePermissionsHash(m, caps)).toBe(computePermissionsHash(m, caps))
  })

  test("capability order does not affect hash", () => {
    const m = minimalManifest()
    const h1 = computePermissionsHash(m, ["a", "b", "c"])
    const h2 = computePermissionsHash(m, ["c", "b", "a"])
    expect(h1).toBe(h2)
  })

  test("differs when capabilities change", () => {
    const m = minimalManifest()
    expect(computePermissionsHash(m, ["read", "write"])).not.toBe(computePermissionsHash(m, ["read"]))
  })

  test("differs when permissions change", () => {
    const a = minimalManifest({
      permissions: {
        tools: { filesystem: "read" as const, shell: false, network: false, mcp: "none" as const },
      },
    })
    const b = minimalManifest({
      permissions: {
        tools: { filesystem: "write" as const, shell: false, network: false, mcp: "none" as const },
      },
    })
    expect(computePermissionsHash(a, [])).not.toBe(computePermissionsHash(b, []))
  })

  test("differs when capability-bearing contributions change", () => {
    const a = minimalManifest({
      contributes: {
        mcp: {
          docs: {
            type: "local" as const,
            command: ["bun", "run", "docs-mcp.ts"],
          },
        },
      },
    })
    const b = minimalManifest({
      contributes: {
        mcp: {
          docs: {
            type: "local" as const,
            command: ["bun", "run", "docs-mcp-v2.ts"],
          },
        },
      },
    })
    expect(computePermissionsHash(a, [])).not.toBe(computePermissionsHash(b, []))
  })
})

describe("verifyApproval", () => {
  const manifest = minimalManifest({
    permissions: {
      tools: { filesystem: "read" as const, shell: false, network: false, mcp: "none" as const },
    },
  })
  const capabilities = ["execute"]

  const record: PluginApprovalRecord = {
    pluginId: "test-plugin",
    source: "npm",
    version: "1.0.0",
    manifestHash: computeManifestHash(manifest),
    permissionsHash: computePermissionsHash(manifest, capabilities),
    approvedAt: Date.now(),
    approvedBy: "user",
    trustTier: "sandbox",
    approvedCapabilities: capabilities,
    approvedNetworkDomains: [],
    approvedUISurfaces: [],
    risk: "low",
  }

  test("returns true when both hashes match", () => {
    expect(verifyApproval(record, manifest, capabilities)).toBe(true)
  })

  test("returns false when manifest changes", () => {
    const modified = minimalManifest({ version: "2.0.0" })
    expect(verifyApproval(record, modified, capabilities)).toBe(false)
  })

  test("returns false when capabilities change", () => {
    expect(verifyApproval(record, manifest, ["execute", "write"])).toBe(false)
  })

  test("returns false when permissions change", () => {
    const modified = minimalManifest({
      permissions: {
        tools: { filesystem: "write" as const, shell: false, network: false, mcp: "none" as const },
      },
    })
    expect(verifyApproval(record, modified, capabilities)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Store persistence tests
// ---------------------------------------------------------------------------

describe("approval store persistence", () => {
  const sample: PluginApprovalRecord = {
    pluginId: "store-test",
    source: "npm",
    version: "1.0.0",
    manifestHash: "abc123",
    permissionsHash: "def456",
    approvedAt: 1700000000000,
    approvedBy: "user",
    trustTier: "sandbox",
    approvedCapabilities: ["execute"],
    approvedNetworkDomains: ["api.example.com"],
    approvedUISurfaces: ["toolRenderers"],
    risk: "medium",
  }

  test("readApprovals returns empty array when no approvals exist", async () => {
    // Start from a clean slate
    const before = await readApprovals()
    await writeApprovals([])
    const after = await readApprovals()
    // Restore
    await writeApprovals(before)
    expect(after).toEqual([])
  })

  test("writeApprovals and readApprovals round-trip", async () => {
    const before = await readApprovals()
    await writeApprovals([sample])
    const result = await readApprovals()
    await writeApprovals(before)
    expect(result).toHaveLength(1)
    expect(result[0].pluginId).toBe("store-test")
  })

  test("getApproval finds by pluginId", async () => {
    const before = await readApprovals()
    await writeApprovals([sample])
    const found = await getApproval("store-test")
    await writeApprovals(before)
    expect(found).toBeDefined()
    expect(found!.pluginId).toBe("store-test")
  })

  test("getApproval returns undefined for unknown pluginId", async () => {
    const before = await readApprovals()
    await writeApprovals([sample])
    const found = await getApproval("nonexistent")
    await writeApprovals(before)
    expect(found).toBeUndefined()
  })

  test("saveApproval inserts a new record", async () => {
    const before = await readApprovals()
    await writeApprovals([])
    await saveApproval(sample)
    const all = await readApprovals()
    await writeApprovals(before)
    expect(all).toHaveLength(1)
    expect(all[0].pluginId).toBe("store-test")
  })

  test("saveApproval updates an existing record", async () => {
    const before = await readApprovals()
    await writeApprovals([sample])
    const updated = { ...sample, risk: "high" as const, version: "2.0.0" }
    await saveApproval(updated)
    const all = await readApprovals()
    await writeApprovals(before)
    expect(all).toHaveLength(1)
    expect(all[0].risk).toBe("high")
    expect(all[0].version).toBe("2.0.0")
  })

  test("removeApproval deletes by pluginId", async () => {
    const before = await readApprovals()
    await writeApprovals([sample])
    await removeApproval("store-test")
    const all = await readApprovals()
    await writeApprovals(before)
    expect(all).toHaveLength(0)
  })

  test("removeApproval is a no-op for unknown pluginId", async () => {
    const before = await readApprovals()
    await writeApprovals([sample])
    await removeApproval("nonexistent")
    const all = await readApprovals()
    await writeApprovals(before)
    expect(all).toHaveLength(1)
  })
})
