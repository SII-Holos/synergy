import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, mock, test } from "bun:test"
import z from "zod"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionProcessor } from "@ericsanchezok/synergy-harness/test/support/internals"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { LocalBashBackend } from "@ericsanchezok/synergy-local-runtime/tools/bash/local"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
const runtime = await testRuntime()

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
    requiresExecution: "exec" as const,
    description: "Bash tool",
    parameters: z.object({
      command: z.string(),
      description: z.string().optional(),
    }),
    async execute(params: { command: string; description?: string }, ctx: any) {
      return LocalBashBackend.execute({ command: params.command }, { ...ctx, workBrief: params.description ?? "bash" })
    },
  }
}

async function resolveBashTool(sessionID: string) {
  const session = await Session.get(sessionID)
  const rootID = Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    rootID,
    isRoot: true,
    sessionID,
    role: "user",
    agent: PrimaryAgentIdentity.names.general,
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  await RolloutLedger.beginRun({ kind: "session", scopeID: session.scope.id, sessionID }, rootID)
  const assistantMessage = {
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant" as const,
    parentID: rootID,
    rootID,
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    agent: PrimaryAgentIdentity.names.general,
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0 },
  }
  await Session.updateMessage(assistantMessage)
  const processor = SessionProcessor.create({
    assistantMessage,
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

test("bash detached daemon guard honors session full_access over agent guarded", () =>
  runtime.run(async () => {
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
              { command: "nohup echo allowed > daemon.log 2>&1" },
              { ...{ toolCallId: "call_bash_nohup" }, workBrief: "Launch daemon" },
            )
            expect(result.metadata.exit).toBe(0)
            const executions: EnvironmentExecution.Info[] = []
            for await (const info of EnvironmentExecution.sessionEntries({
              scopeID: session.scope.id,
              sessionID: session.id,
            }))
              executions.push(info)
            expect(executions).toHaveLength(1)
            expect(executions[0]).toMatchObject({
              state: "completed",
              origin: { kind: "session", sessionID: session.id, callID: "call_bash_nohup", tool: "bash" },
            })
          } finally {
            processor.dispose("test")
          }
        } finally {
          await Session.remove(session.id)
          ;(ToolRegistry.tools as any) = originalRegistryTools
        }
      },
    })
  }))

test("bash detached daemon guard honors inherited session full_access", () =>
  runtime.run(async () => {
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
              { command: "nohup echo allowed > daemon.log 2>&1" },
              { ...{ toolCallId: "call_bash_setsid" }, workBrief: "Launch daemon" },
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
  }))

afterRuntimeTests(() => runtime.close())
