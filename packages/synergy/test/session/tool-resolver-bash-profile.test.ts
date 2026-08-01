import { expect, mock, test } from "bun:test"
import z from "zod"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionProcessor } from "../../src/session/processor"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { ToolRegistry } from "../../src/tool/registry"
import { LocalBashBackend } from "../../src/tool/bash/local"

// Regression for issue #1006: the bash detached-daemon guard must honor the
// session-effective control profile (session > agent config), not the static
// agent-declared profile. The resolver previously injected
// `extra.controlProfile: input.agent.controlProfile` into the tool context,
// so a session switched to full_access was still blocked by the guard when
// the agent itself declared a weaker profile.

const guardedAgent = {
  name: "synergy",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  controlProfile: "guarded",
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
      id: "msg_tool_resolver_profile",
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
      agent: guardedAgent,
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

test("bash detached daemon guard honors session full_access over agent guarded", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const originalRegistryTools = ToolRegistry.tools
      ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool()])
      const session = await Session.create({ controlProfile: "full_access" })
      try {
        const { processor, bash } = await resolveBashTool(session.id)
        try {
          const result = await bash.execute(
            { command: "nohup echo allowed > daemon.log 2>&1", description: "Launch daemon" },
            { toolCallId: "call_bash_nohup" },
          )
          expect(result.metadata.exit).toBe(0)
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

test("bash detached daemon guard honors inherited session full_access", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const originalRegistryTools = ToolRegistry.tools
      ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool()])
      const parent = await Session.create({ controlProfile: "full_access" })
      const child = await Session.create({ parentID: parent.id })
      try {
        const { processor, bash } = await resolveBashTool(child.id)
        try {
          const result = await bash.execute(
            { command: "nohup echo allowed > daemon.log 2>&1", description: "Launch daemon" },
            { toolCallId: "call_bash_setsid" },
          )
          expect(result.metadata.exit).toBe(0)
        } finally {
          processor.dispose("test")
        }
      } finally {
        await Session.remove(child.id)
        await Session.remove(parent.id)
        ;(ToolRegistry.tools as any) = originalRegistryTools
      }
    },
  })
})
