import { describe, expect, test } from "bun:test"
import { EnforcementGate } from "../../src/enforcement/gate"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"

const planSession = {
  workflow: { kind: "plan" },
} as any

async function bashDiagnostic(command: string) {
  const gate = await EnforcementGate.create({
    activeWorkspace: "/tmp/synergy-plan",
    workspaceType: "main",
  })
  const envelope = gate.evaluate("bash", { command })
  return SessionModePolicy.evaluateCall({
    toolName: "bash",
    args: { command },
    session: planSession,
    capabilities: envelope.capabilities,
  })
}

describe("SessionModePolicy Plan visibility", () => {
  test("allows bash to stay visible in Plan", () => {
    expect(SessionModePolicy.visibility({ toolName: "bash", session: planSession })).toBeUndefined()
  })

  test("blocks direct implementation write tools in Plan", () => {
    const diagnostic = SessionModePolicy.visibility({ toolName: "edit", session: planSession })
    expect(diagnostic?.code).toBe("plan_mode_blocked")
    expect(diagnostic?.mode).toBe("plan")
  })
})

describe("SessionModePolicy Plan bash calls", () => {
  test("does not add a Plan-only bash restriction", async () => {
    await expect(bashDiagnostic('rg "ToolResolver" packages/synergy/src')).resolves.toBeUndefined()
    await expect(
      bashDiagnostic("ls -la && cat package.json && git diff -- packages/synergy/src/session/tool-resolver.ts"),
    ).resolves.toBeUndefined()
    await expect(bashDiagnostic("git status --short")).resolves.toBeUndefined()
    await expect(bashDiagnostic("npm view @ericsanchezok/synergy-plugin versions --json")).resolves.toBeUndefined()
    await expect(bashDiagnostic("bun pm view @ericsanchezok/synergy-plugin version")).resolves.toBeUndefined()
    for (const command of ["echo hi > file.txt", "rm file.txt", "git commit -m test", "git push origin main"]) {
      await expect(bashDiagnostic(command)).resolves.toBeUndefined()
    }
  })
})

describe("SessionModePolicy Lattice execution visibility", () => {
  test("explains that parent Lattice tools cannot be bypassed during the owned BlueprintLoop step", () => {
    const diagnostic = SessionModePolicy.visibility({
      toolName: "lattice_submit",
      session: {
        workflow: { kind: "lattice", runID: "ltr_test", mode: "auto" },
        blueprint: { loopID: "bpl_test", loopRole: "execution" },
      } as any,
    })

    expect(diagnostic).toMatchObject({
      code: "tool_unavailable",
      toolName: "lattice_submit",
      metadata: {
        submitted: false,
        owner: "blueprint_loop",
        loopID: "bpl_test",
        retryable: false,
      },
    })
    expect(diagnostic?.message).toContain("No Lattice action was submitted")
    expect(diagnostic?.message).toContain("Do not work around this boundary")
    expect(diagnostic?.message).toContain("future Pathway Step")
    expect(diagnostic?.message).toContain("blueprint_loop_stop")
    expect(diagnostic?.message).toContain("end this assistant turn immediately")
  })
})
