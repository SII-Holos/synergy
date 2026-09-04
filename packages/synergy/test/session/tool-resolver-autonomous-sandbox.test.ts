import { expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import z from "zod"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionProcessor } from "../../src/session/processor"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { ToolRegistry } from "../../src/tool/registry"
import { LocalBashBackend } from "../../src/tool/bash/local"
import { SandboxBackend } from "../../src/sandbox/backend"

// ---------------------------------------------------------------------------
// B1 regression: profile-auto-allowed bash under autonomous must NOT bypass
// the OS sandbox. The resolver previously called markShellSandboxBypass for
// every profile auto-allow, so autonomous bash ran bare and writes that static
// classification cannot see (variable redirect targets like out=/tmp/...)
// landed on the host. Under autonomous the sandboxPrepare wrapper must be
// installed (and therefore invoked), and the child must receive the
// workspace-controlled TMPDIR instead of the host temporary directory.
//
// full_access keeps the historical bypass: sandboxPrepare is never installed.
// ---------------------------------------------------------------------------

const agent = {
  name: "synergy",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  controlProfile: "autonomous",
} as any

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any

function bashRegistryTool() {
  return {
    id: "bash",
    description: "Bash tool",
    parameters: z.object({
      command: z.string(),
      description: z.string().optional(),
    }),
    async execute(params: { command: string; description?: string }, ctx: any) {
      return LocalBashBackend.execute({ command: params.command, description: params.description ?? "bash" }, ctx)
    },
  }
}

async function resolveBashTool(sessionID: string) {
  const session = await Session.get(sessionID)
  const processor = SessionProcessor.create({
    assistantMessage: {
      id: "msg_tool_resolver_autonomous",
      sessionID,
      role: "assistant",
      parentID: "msg_user",
      modelID: "test-model",
      providerID: "test-provider",
      mode: "build",
      agent: "synergy",
      path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0 },
    },
    sessionID,
    model,
    abort: new AbortController().signal,
  })
  try {
    const resolved = await ToolResolver.resolveWithAvailability({
      agent,
      model,
      sessionID,
      session,
      processor,
      userTools: { bash: true },
      includeMCP: false,
    })
    return { processor, bash: resolved.executionTools.bash as any }
  } catch (error) {
    processor.dispose("test")
    throw error
  }
}

test("autonomous profile-auto-allowed bash installs the sandbox wrapper and runs with controlled TMPDIR", async () => {
  await using tmp = await tmpdir({ git: true, config: { controlProfile: "autonomous" } })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const originalRegistryTools = ToolRegistry.tools
      ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool()])
      const prepare = spyOn(SandboxBackend, "prepareWrapper").mockImplementation((input) => ({
        command: input.command,
        args: input.args,
        sandboxed: true,
      }))
      const session = await Session.create({ controlProfile: "autonomous" })
      try {
        const { processor, bash } = await resolveBashTool(session.id)
        try {
          const result = await bash.execute(
            { command: 'echo "$TMPDIR"', description: "Probe controlled tmp" },
            { toolCallId: "call_bash_autonomous" },
          )
          expect(result.metadata.exit).toBe(0)
          // The sandbox wrapper was prepared: auto-allow did not bypass.
          expect(prepare.mock.calls.length).toBeGreaterThan(0)
          expect(prepare.mock.calls[0][0].sandboxMode).toBe("workspace_write")
          // TMPDIR pointed into the workspace-controlled temporary root.
          expect(result.output).toContain(".synergy/tmp")
          expect(result.output).toContain(tmp.path)
        } finally {
          processor.dispose("test")
        }
      } finally {
        await Session.remove(session.id)
        ;(ToolRegistry.tools as any) = originalRegistryTools
        prepare.mockRestore()
      }
    },
  })
})
test("autonomous gate-approved external read is forwarded into the sandbox wrapper read roots", async () => {
  if (!fs.existsSync("/etc/hosts")) return
  await using tmp = await tmpdir({ git: true, config: { controlProfile: "autonomous" } })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const originalRegistryTools = ToolRegistry.tools
      ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool()])
      const prepare = spyOn(SandboxBackend, "prepareWrapper").mockImplementation((input) => ({
        command: input.command,
        args: input.args,
        sandboxed: true,
      }))
      const session = await Session.create({ controlProfile: "autonomous" })
      try {
        const { processor, bash } = await resolveBashTool(session.id)
        try {
          const result = await bash.execute(
            { command: "cat /etc/hosts", description: "probe" },
            { toolCallId: "call_bash_autonomous_ext_read" },
          )
          // The gate auto-allowed the external read and the wrapper was
          // prepared (auto-allow never bypasses the sandbox under autonomous).
          expect(result.metadata.exit).toBe(0)
          expect(prepare.mock.calls.length).toBeGreaterThan(0)
          const lastInput = prepare.mock.calls[prepare.mock.calls.length - 1][0]
          // The gate-approved external read reaches the wrapper's read roots.
          expect(lastInput.extraReadRoots).toContain("/etc/hosts")
          // The workspace stays readable.
          expect(lastInput.extraReadRoots).toContain(tmp.path)
          // The session-scoped controlled temp root is a writable root.
          expect(
            (lastInput.extraWritableRoots ?? []).some((root: string) =>
              root.startsWith(`${tmp.path}/.synergy/tmp/synergy-${process.pid}-`),
            ),
          ).toBe(true)
        } finally {
          processor.dispose("test")
        }
      } finally {
        await Session.remove(session.id)
        ;(ToolRegistry.tools as any) = originalRegistryTools
        prepare.mockRestore()
      }
    },
  })
})

test("full_access keeps the historical sandbox bypass for bash", async () => {
  await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const originalRegistryTools = ToolRegistry.tools
      ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool()])
      const prepare = spyOn(SandboxBackend, "prepareWrapper").mockImplementation((input) => ({
        command: input.command,
        args: input.args,
        sandboxed: true,
      }))
      const session = await Session.create({ controlProfile: "full_access" })
      try {
        const { processor, bash } = await resolveBashTool(session.id)
        try {
          const result = await bash.execute(
            { command: "echo bypass-ok", description: "Probe bypass" },
            { toolCallId: "call_bash_full_access" },
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("bypass-ok")
          expect(prepare.mock.calls.length).toBe(0)
        } finally {
          processor.dispose("test")
        }
      } finally {
        await Session.remove(session.id)
        ;(ToolRegistry.tools as any) = originalRegistryTools
        prepare.mockRestore()
      }
    },
  })
})

test("real OS sandbox contains a variable-target host tmp write under autonomous (darwin)", async () => {
  // R1 execution anchor on the host platform: with the B1/B2 chain live (no
  // wrapper mock), a profile-auto-allowed command whose write target is only
  // visible at runtime (`out=/tmp/...`) must NOT create a host file. The
  // sandbox denies the write; the controlled temp root is created inside the
  // workspace and the workspace stays writable.
  if (process.platform !== "darwin") return
  const probe = SandboxBackend.prepareWrapper({
    command: "/usr/bin/true",
    args: [],
    workspace: process.cwd(),
    sandboxMode: "workspace_write",
  })
  if (probe.skipReason) return

  await using tmp = await tmpdir({ git: true, config: { controlProfile: "autonomous" } })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const originalRegistryTools = ToolRegistry.tools
      ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool()])
      const session = await Session.create({ controlProfile: "autonomous" })
      const hostFile = path.join(os.tmpdir(), `synergy-e2e-${process.pid}-${Date.now()}.txt`)
      try {
        const { processor, bash } = await resolveBashTool(session.id)
        try {
          const result = await bash.execute(
            {
              command: `out=${hostFile}; { echo hi; } > "$out" 2>&1; echo done; echo "t=\\"$TMPDIR\\""`,
              description: "Contained variable-target write probe",
            },
            { toolCallId: "call_bash_e2e" },
          )
          // The shell survives the denied redirect and reports completion;
          // the sandboxed child received a workspace-controlled TMPDIR.
          expect(result.output).toContain("done")
          expect(result.output).toContain(".synergy/tmp")
          expect(result.output).toContain(tmp.path)
          // The host shared temporary directory was NOT written.
          expect(fs.existsSync(hostFile)).toBe(false)
        } finally {
          processor.dispose("test")
        }
      } finally {
        await Session.remove(session.id)
        ;(ToolRegistry.tools as any) = originalRegistryTools
        try {
          fs.unlinkSync(hostFile)
        } catch {}
      }
    },
  })
})

test("real OS sandbox allows workspace writes under autonomous (darwin)", async () => {
  if (process.platform !== "darwin") return
  const probe = SandboxBackend.prepareWrapper({
    command: "/usr/bin/true",
    args: [],
    workspace: process.cwd(),
    sandboxMode: "workspace_write",
  })
  if (probe.skipReason) return

  await using tmp = await tmpdir({ git: true, config: { controlProfile: "autonomous" } })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const originalRegistryTools = ToolRegistry.tools
      ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool()])
      const session = await Session.create({ controlProfile: "autonomous" })
      try {
        const { processor, bash } = await resolveBashTool(session.id)
        try {
          const target = path.join(tmp.path, "ws-e2e.txt")
          const result = await bash.execute(
            { command: `echo ws-ok > "${target}" && cat "${target}"`, description: "Workspace write probe" },
            { toolCallId: "call_bash_e2e_ws" },
          )
          expect(result.output).toContain("ws-ok")
          expect(fs.existsSync(target)).toBe(true)
        } finally {
          processor.dispose("test")
        }
      } finally {
        await Session.remove(session.id)
        ;(ToolRegistry.tools as any) = originalRegistryTools
      }
    },
  })
})
