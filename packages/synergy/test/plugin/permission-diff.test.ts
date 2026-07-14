import { describe, expect, test } from "bun:test"
import { diffPermissions } from "../../src/plugin/consent/diff"

describe("permission diff", () => {
  test("new install: everything added, no oldVersion", () => {
    const diff = diffPermissions("test-plugin", {
      newVersion: "1.0.0",
      oldCapabilities: [],
      newCapabilities: ["session.read", "workspace.read"],
    })
    expect(diff.fromVersion).toBeUndefined()
    expect(diff.riskBefore).toBeUndefined()
    expect(diff.requiresApproval).toBe(true)
    expect(diff.reason).toBe("New plugin installation — all permissions require approval.")
    expect(diff.added.length).toBe(2)
    expect(diff.removed.length).toBe(0)
    expect(diff.unchanged.length).toBe(0)
    expect(diff.changed.length).toBe(0)
  })

  test("no changes: requiresApproval false, reason undefined", () => {
    const diff = diffPermissions("test-plugin", {
      oldVersion: "1.0.0",
      newVersion: "1.1.0",
      oldCapabilities: ["session.read"],
      newCapabilities: ["session.read"],
    })
    expect(diff.fromVersion).toBe("1.0.0")
    expect(diff.requiresApproval).toBe(false)
    expect(diff.reason).toBeUndefined()
    expect(diff.added.length).toBe(0)
    expect(diff.removed.length).toBe(0)
    expect(diff.unchanged.length).toBe(1)
    expect(diff.changed.length).toBe(0)
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
    expect(diff.requiresApproval).toBe(true)
    expect(diff.reason).toBe("Permission changes detected between versions.")
    expect(diff.added.length).toBe(1)
    expect(diff.added[0]!.key).toBe("workspace.write")
  })

  test("capability removed triggers approval with reason", () => {
    const diff = diffPermissions("test-plugin", {
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
      oldCapabilities: ["session.read", "workspace.read"],
      newCapabilities: ["session.read"],
    })
    expect(diff.requiresApproval).toBe(true)
    expect(diff.reason).toBe("Permission changes detected between versions.")
    expect(diff.removed.length).toBe(1)
    expect(diff.removed[0]!.key).toBe("workspace.read")
    expect(diff.added.length).toBe(0)
  })

  test("risk change triggers approval", () => {
    const diff = diffPermissions("test-plugin", {
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
      oldCapabilities: ["session.read"],
      newCapabilities: ["workspace.write"],
    })
    expect(diff.requiresApproval).toBe(true)
    expect(diff.riskBefore).toBe("medium")
    expect(diff.riskAfter).toBe("high")
  })

  test("empty capabilities: new install with none", () => {
    const diff = diffPermissions("test-plugin", {
      newVersion: "1.0.0",
      oldCapabilities: [],
      newCapabilities: [],
    })
    expect(diff.requiresApproval).toBe(false)
    expect(diff.added.length).toBe(0)
    expect(diff.reason).toBeUndefined()
  })
})
