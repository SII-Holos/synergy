import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")
import { controlledTempRoot } from "../../src/sandbox/policy"

const WORKSPACE = "/Users/test/synergy-control-profile"

// ---------------------------------------------------------------------------
// B2 anchors: the controlled temporary root (workspace/.synergy/tmp) is a
// first-class autonomous write root. Literal writes under the controlled root
// classify as workspace file_write (never external), while host /tmp writes
// stay file_external_write deny. The aggregated sandbox permission profile
// must list the controlled root among its writable roots.
// ---------------------------------------------------------------------------

describe("controlled temporary write root (B2)", () => {
  test("literal write under the controlled root classifies file_write and is allowed under autonomous", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const controlled = controlledTempRoot(WORKSPACE)
    const command = `git status > "${controlled}/scan.txt"`

    const result = gate.classify("bash", { command, workdir: WORKSPACE })
    const write = result.capabilities.find((c: any) => c.class === "file_write")
    expect(write).toBeDefined()
    expect(result.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
    expect(gate.evaluate("bash", { command, workdir: WORKSPACE }).decision).toBe("allow")
  })

  test("literal write to the host shared tmp stays file_external_write deny", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const result = gate.classify("bash", { command: "git status > /tmp/out.txt", workdir: WORKSPACE })
    const externalWrite = result.capabilities.find((c: any) => c.class === "file_external_write")
    expect(externalWrite).toBeDefined()
    expect(gate.evaluate("bash", { command: "git status > /tmp/out.txt", workdir: WORKSPACE }).decision).toBe("deny")
  })

  test("aggregated sandbox writable roots include the controlled root for autonomous", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    // An allowed workspace write accumulates approved paths; the profile
    // writeRoots seed already carries the controlled root.
    gate.evaluate("bash", { command: "git status > scan.txt", workdir: WORKSPACE })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.writableRoots).toContain(controlledTempRoot(WORKSPACE))
    expect(policy!.fileSystem.writableRoots).toContain(WORKSPACE)
  })
})
