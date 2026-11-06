import { describe, expect, test } from "bun:test"
import { broadenedPermissionItems, comparePluginAccess, diffPermissions } from "../../src/plugin/consent/diff"
import { permissionsHashPayload } from "@ericsanchezok/synergy-plugin/integrity"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"

function manifest(input: {
  version: string
  capabilities?: PluginManifestType["capabilities"]
  contributions?: PluginManifestType["contributions"]
}): PluginManifestType {
  return {
    manifestVersion: 1,
    apiVersion: "4.0",
    compatibility: { synergy: ">=3.0.11" },
    id: "test-plugin",
    name: "Test Plugin",
    version: input.version,
    description: "Fixture",
    capabilities: input.capabilities ?? [],
    contributions: input.contributions ?? [],
    artifacts: { generation: `generation-${input.version}` },
  }
}

describe("permission diff", () => {
  test("new install: everything added, no oldVersion", () => {
    const diff = diffPermissions("test-plugin", {
      newVersion: "1.0.0",
      oldCapabilities: [],
      newCapabilities: ["session.read", "workspace.read"],
    })
    expect(diff.fromVersion).toBeUndefined()
    expect(diff.requiresConfirmation).toBe(true)
    expect(diff.confirmationReason).toBe("non_official_source")
    expect(diff.added.length).toBe(2)
    expect(diff.removed.length).toBe(0)
    expect(diff.broadened.length).toBe(0)
  })

  test("no changes do not require confirmation", () => {
    const diff = diffPermissions("test-plugin", {
      oldVersion: "1.0.0",
      newVersion: "1.1.0",
      oldCapabilities: ["session.read"],
      newCapabilities: ["session.read"],
    })
    expect(diff.fromVersion).toBe("1.0.0")
    expect(diff.requiresConfirmation).toBe(false)
    expect(diff.confirmationReason).toBeUndefined()
    expect(diff.added.length).toBe(0)
    expect(diff.removed.length).toBe(0)
    expect(diff.access.length).toBe(1)
  })

  test("manifest-only updates reuse the existing grant", () => {
    const before = manifest({ version: "1.0.0", capabilities: [{ id: "session.read" }] })
    const after = { ...manifest({ version: "1.1.0", capabilities: [{ id: "session.read" }] }), description: "Changed" }
    expect(comparePluginAccess(permissionsHashPayload(before), permissionsHashPayload(after))).toBe("equal")
  })

  test("adding trusted UI broadens the grant", () => {
    const before = manifest({ version: "1.0.0" })
    const after = manifest({
      version: "1.1.0",
      contributions: [
        {
          kind: "ui.workbenchPanel",
          id: "panel",
          label: "Panel",
          order: 0,
          surface: "side",
          cardinality: "singleton",
          component: { entry: "ui/index.js", exportName: "default" },
        },
      ],
    })
    expect(comparePluginAccess(permissionsHashPayload(before), permissionsHashPayload(after))).toBe("broadened")
  })

  test("capability added triggers approval with reason", () => {
    const diff = diffPermissions("test-plugin", {
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
      oldCapabilities: ["session.read"],
      newCapabilities: ["session.read", "workspace.write"],
    })
    expect(diff.fromVersion).toBe("1.0.0")
    expect(diff.toVersion).toBe("2.0.0")
    expect(diff.requiresConfirmation).toBe(true)
    expect(diff.confirmationReason).toBe("access_expanded")
    expect(diff.added.length).toBe(1)
    expect(diff.added[0]!.key).toBe("workspace.write")
  })

  test("capability removal narrows access without confirmation", () => {
    const diff = diffPermissions("test-plugin", {
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
      oldCapabilities: ["session.read", "workspace.read"],
      newCapabilities: ["session.read"],
    })
    expect(diff.requiresConfirmation).toBe(false)
    expect(diff.removed.length).toBe(1)
    expect(diff.removed[0]!.key).toBe("workspace.read")
    expect(diff.added.length).toBe(0)
  })

  test("known constraint narrowing does not require confirmation", () => {
    const before = manifest({
      version: "1.0.0",
      capabilities: [{ id: "task.delegate", constraints: { agents: ["one", "two"], maxRuntimeMs: 120_000 } }],
    })
    const after = manifest({
      version: "1.1.0",
      capabilities: [{ id: "task.delegate", constraints: { agents: ["one"], maxRuntimeMs: 60_000 } }],
    })
    expect(comparePluginAccess(permissionsHashPayload(before), permissionsHashPayload(after))).toBe("narrowed")
  })

  test("reports only the capability whose constraint broadened", () => {
    const before = manifest({
      version: "1.0.0",
      capabilities: [
        { id: "task.delegate", constraints: { agents: ["one"], maxRuntimeMs: 60_000 } },
        { id: "asset.write" },
      ],
    })
    const after = manifest({
      version: "1.1.0",
      capabilities: [
        { id: "task.delegate", constraints: { agents: ["one", "two"], maxRuntimeMs: 120_000 } },
        { id: "asset.write" },
      ],
    })
    expect(broadenedPermissionItems(permissionsHashPayload(before), permissionsHashPayload(after))).toEqual([
      expect.objectContaining({ key: "task.delegate" }),
    ])
  })

  test("reports a newly trusted UI contribution without repeating unrelated access", () => {
    const before = manifest({ version: "1.0.0", capabilities: [{ id: "workspace.read" }] })
    const after = manifest({
      version: "1.1.0",
      capabilities: [{ id: "workspace.read" }],
      contributions: [
        {
          kind: "ui.workbenchPanel",
          id: "panel",
          label: "Panel",
          order: 0,
          surface: "side",
          cardinality: "singleton",
          component: { entry: "ui/index.js", exportName: "default" },
        },
      ],
    })
    expect(broadenedPermissionItems(permissionsHashPayload(before), permissionsHashPayload(after))).toEqual([
      expect.objectContaining({ key: "contribution:ui.workbenchPanel:panel", category: "ui" }),
    ])
  })

  test("third-party install still requires source confirmation when it requests no host access", () => {
    const diff = diffPermissions("test-plugin", {
      newVersion: "1.0.0",
      oldCapabilities: [],
      newCapabilities: [],
    })
    expect(diff.requiresConfirmation).toBe(true)
    expect(diff.added.length).toBe(0)
    expect(diff.reason).toBe("Confirm access for this third-party plugin.")
  })
})
