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

    // A redirect target inside a shell command is sandbox-owned, so the gate
    // predicts no write at all; the sandbox writable roots carry the controlled
    // root (asserted below). The structured write tool still classifies a
    // literal path under that root as a workspace write.
    const result = gate.classify("bash", { command, workdir: WORKSPACE })
    expect(result.capabilities.map((c: any) => c.class).filter((n: string) => n.startsWith("file_"))).toEqual([])
    expect(gate.evaluate("bash", { command, workdir: WORKSPACE }).decision).toBe("allow")
    const structured = gate.classify("write", { filePath: `${controlled}/scan.txt` })
    const write = structured.capabilities.find((c: any) => c.class === "file_write")
    expect(write).toBeDefined()
    expect(structured.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
  })

  test("literal write to the host shared tmp stays file_external_write deny", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    // The host shared tmp is outside every sandbox write root, so a literal
    // write there is an external write the sandbox refuses.
    const structured = gate.classify("write", { filePath: "/tmp/out.txt" })
    const externalWrite = structured.capabilities.find((c: any) => c.class === "file_external_write")
    expect(externalWrite).toBeDefined()
    expect(gate.evaluate("write", { filePath: "/tmp/out.txt" }).decision).toBe("deny")
    const bash = gate.classify("bash", { command: "git status > /tmp/out.txt", workdir: WORKSPACE })
    expect(bash.capabilities.map((c: any) => c.class).filter((n: string) => n.startsWith("file_"))).toEqual([])
  })

  test("aggregated sandbox writable roots include the controlled root for autonomous", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    // An allowed workspace write accumulates approved paths; the profile
    // writeRoots seed already carries the controlled root.
    gate.evaluate("write", { filePath: `${WORKSPACE}/scan.txt` })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.writableRoots).toContain(controlledTempRoot(WORKSPACE))
    expect(policy!.fileSystem.writableRoots).toContain(WORKSPACE)
  })
})
