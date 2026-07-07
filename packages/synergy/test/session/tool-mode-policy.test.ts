import { describe, expect, test } from "bun:test"
import { EnforcementGate } from "../../src/enforcement/gate"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"

const planSession = {
  planMode: true,
} as any

async function bashDiagnostic(command: string) {
  const gate = await EnforcementGate.create({
    activeWorkspace: "/tmp/synergy-plan-mode",
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

describe("SessionModePolicy Plan Mode visibility", () => {
  test("allows bash to stay visible in Plan Mode", () => {
    expect(SessionModePolicy.visibility({ toolName: "bash", session: planSession })).toBeUndefined()
  })

  test("blocks direct implementation write tools in Plan Mode", () => {
    const diagnostic = SessionModePolicy.visibility({ toolName: "edit", session: planSession })
    expect(diagnostic?.code).toBe("plan_mode_blocked")
    expect(diagnostic?.mode).toBe("plan")
  })
})

describe("SessionModePolicy Plan Mode bash calls", () => {
  test("does not add a Plan Mode-only bash restriction", async () => {
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
