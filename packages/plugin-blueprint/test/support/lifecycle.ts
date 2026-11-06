import path from "node:path"
import { pathToFileURL } from "node:url"
import { agent, capability, compilePluginManifest, definePlugin, hook } from "@ericsanchezok/synergy-plugin"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderCatalogSource } from "@ericsanchezok/synergy-harness/provider/catalog-source"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { sha256File } from "@ericsanchezok/synergy-harness/util/crypto"
import { createApprovalRecord, saveApproval } from "@ericsanchezok/synergy-plugin-host/plugin/consent/approval-store"
import { pluginRuntimeManager } from "@ericsanchezok/synergy-plugin-host/plugin/runtime"
import { hash as sha256 } from "@ericsanchezok/synergy-util/encode"
import { testRuntime } from "./runtime"

export const pluginID = "blueprint-lifecycle"
export const generation = "generation-one"
export const executionAgent = "blueprint-fixture-executor"
export const auditAgent = "blueprint-fixture-reviewer"
const model = { providerID: "fixture", modelID: "chat" }

async function writePlugin(directory: string) {
  const runtimePath = path.join(directory, "runtime.js")
  const receiptsPath = path.join(directory, "receipts.json")
  const definition = definePlugin({
    id: pluginID,
    version: "1.0.0",
    description: "Blueprint lifecycle fixture",
    capabilities: [capability("blueprint.delegate", { agents: [executionAgent, auditAgent] })],
    contributions: [
      ...[executionAgent, auditAgent].map((name) =>
        agent({
          id: name,
          agent: { name, description: name, prompt: "Perform the assigned role.", mode: "subagent", hidden: true },
        }),
      ),
      hook({ id: "finished", point: "blueprint.after", priority: 0, async handler() {} }),
    ],
  })
  await Bun.write(
    runtimePath,
    `export default {
      ...${JSON.stringify(definition)},
      contributions: [{ kind: "hook", id: "finished", point: "blueprint.after", priority: 0,
        async handler(input, context) {
          const file = Bun.file(${JSON.stringify(receiptsPath)})
          const receipts = await file.exists() ? await file.json() : []
          receipts.push({ loop: input.loop, sessionId: context.sessionId, generation: context.runtime.pluginGeneration })
          await Bun.write(file, JSON.stringify(receipts))
        }
      }]
    }`,
  )
  const manifest = compilePluginManifest(definition, {
    generation,
    runtime: { entry: "runtime.js", sha256: sha256File(runtimePath) },
  })
  await Bun.write(path.join(directory, "plugin.json"), JSON.stringify(manifest))
  return { manifest, receiptsPath }
}

function modelBoundary() {
  const calls: AgentTurn.Input[] = []
  const releases = new Set<() => void>()
  const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<AgentTurn.Input>>>()
  const register = () => {
    ProviderCatalogSource.register({
      providers: async () => ({
        fixture: Provider.fromModelsDevProvider({
          id: "fixture",
          name: "Fixture",
          env: [],
          npm: "fixture-sdk",
          api: "https://example.invalid",
          models: {
            chat: {
              id: "chat",
              name: "Chat",
              release_date: "2026-01-01",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              limit: { context: 128000, output: 8000 },
              options: {},
            },
          },
        }),
      }),
    })
    AgentTurn.setInProcessStream(async (input) => {
      const execution = input.agent.name === executionAgent || input.agent.name === auditAgent
      const ended = Promise.withResolvers<void>()
      const release = () => ended.resolve()
      releases.add(release)
      input.abort.addEventListener("abort", release, { once: true })
      if (input.abort.aborted) release()
      calls.push(input)
      if (execution) waiting.get(input.sessionID)?.resolve(input)
      return {
        fullStream: (async function* () {
          if (!execution) {
            yield { type: "text-delta" as const, id: "test-text", text: "Blueprint lifecycle fixture" }
            return
          }
          yield { type: "start" as const }
          await ended.promise
          yield { type: "abort" as const }
        })(),
        usage: Promise.resolve(undefined),
        async dispose() {
          release()
          input.abort.removeEventListener("abort", release)
          releases.delete(release)
        },
      }
    })
  }
  return {
    calls,
    register,
    release() {
      for (const release of releases) release()
    },
    async started(sessionID: string) {
      const existing = calls.find((call) => call.sessionID === sessionID && call.agent.name === executionAgent)
      if (existing) return existing
      const pending = Promise.withResolvers<AgentTurn.Input>()
      waiting.set(sessionID, pending)
      const timeout = setTimeout(() => pending.reject(new Error("Blueprint execution never reached the model")), 5000)
      try {
        return await pending.promise
      } finally {
        clearTimeout(timeout)
        waiting.delete(sessionID)
      }
    },
  }
}

export async function withLifecycle<T>(fn: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<T>) {
  const boundary = modelBoundary()
  await using runtime = await testRuntime({ register: boundary.register })
  return await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginDir = path.join(tmp.path, "plugin")
    const plugin = await writePlugin(pluginDir)
    return await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await saveApproval(createApprovalRecord({ pluginId: pluginID, source: "local", manifest: plugin.manifest }))
        await Config.update({
          model: "fixture/chat",
          compaction: { auto: false },
          plugin: [pathToFileURL(pluginDir).href],
        })
        await Agent.reload()
        try {
          return await fn(await setup(pluginDir, plugin.receiptsPath, boundary))
        } finally {
          for (const task of Cortex.list()) await Cortex.cancel(task.id)
          boundary.release()
          await Cortex.stop()
          await pluginRuntimeManager().stop(pluginID, 0)
        }
      },
    })
  })
}

async function setup(pluginDir: string, receiptsPath: string, boundary: ReturnType<typeof modelBoundary>) {
  const parent = await Session.create({ title: "Blueprint parent" })
  const markdown = "# Release contract\n\nKeep this source only in the frozen Note."
  return {
    parent,
    boundary,
    receipts: async () => {
      const file = Bun.file(receiptsPath)
      return file.exists().then((exists) => (exists ? file.json() : [])) as Promise<
        {
          loop: { id: string; status: string; pluginOwner: { pluginId: string; pluginGeneration: string } }
          sessionId: string
          generation: string
        }[]
      >
    },
    input: {
      context: {
        pluginId: pluginID,
        pluginGeneration: generation,
        scopeId: parent.scope.id,
        pluginDir,
        parentSessionID: parent.id,
        parentMessageID: Identifier.ascending("message"),
      },
      request: {
        title: " Release contract ",
        description: " Independently reviewed release ",
        markdown,
        sourceDigest: await sha256(markdown),
        correlationId: " release-one ",
        executionAgent,
        auditAgent,
        executionModel: model,
        executionTools: { note_read: true },
        auditTools: { note_read: true, blueprint_loop_approve: true, blueprint_loop_reject: true },
        budget: { maxRuntimeMs: 60000, maxIterations: 3 },
      },
    },
  }
}
