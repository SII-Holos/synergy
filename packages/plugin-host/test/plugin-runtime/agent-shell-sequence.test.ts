import { expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutTool } from "@ericsanchezok/synergy-harness/session/rollout/tool"
import { ToolPluginSource } from "@ericsanchezok/synergy-harness/tool/plugin-source"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { pluginContributionAdapters } from "../../src/plugin/contribution-registry"
import { PluginToolId } from "../../src/plugin/ids"
import { state as pluginState } from "../../src/plugin/loader"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import { registerToolPluginSource } from "../../src/plugin/tool-source"
import definition from "./fixtures/agent-shell-sequence-plugin"
import { testRuntime } from "../support/runtime"

const ShellResult = z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number() })

test("one native Agent Plugin Tool retains separate preparations for two actual shell calls", async () => {
  const began = Date.now()
  const phases: { phase: string; elapsed: number }[] = []
  const phase = (name: string) => phases.push({ phase: name, elapsed: Date.now() - began })
  await using runtime = await testRuntime({ register: registerToolPluginSource })
  await runtime.run(async () => {
    await using temporary = await tmpdir({ config: { controlProfile: "full_access" } })
    const scope = await temporary.scope()
    await ScopeContext.provide({
      scope,
      async fn() {
        const session = await Session.create({ controlProfile: "full_access" })
        const rootID = Identifier.ascending("message")
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          rootID,
          isRoot: true,
          agent: PrimaryAgentIdentity.names.general,
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: Date.now() },
        })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: rootID,
          rootID,
          agent: PrimaryAgentIdentity.names.general,
          providerID: "fixture",
          modelID: "fixture",
          mode: "default",
          path: { cwd: temporary.path, root: temporary.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })
        const manifest = compilePluginManifest(definition, {
          generation: "agent-shell-sequence",
          runtime: { entry: "runtime/index.js", sha256: "fixture" },
        })
        const entryPath = path.join(import.meta.dir, "fixtures", "agent-shell-sequence-plugin.ts")
        const manager = pluginRuntimeManager()
        const catalog = await pluginState()
        catalog.loaded.push({
          id: manifest.id,
          name: "Agent shell sequence fixture",
          manifest,
          pluginDir: path.dirname(entryPath),
          entryPath,
          source: "builtin",
          spec: "agent-shell-sequence-fixture",
          enabledScopes: new Set([scope.id]),
          contributionHealth: new Map(),
        })
        pluginContributionAdapters().registerPlugin(manifest.id, manifest)
        const source = ToolPluginSource.get()
        if (!source) throw new Error("The real Plugin Tool source was not composed")
        const tool = PluginToolId.format(definition.id, "two-shells")
        const entry = (await source.toolEntries()).find((entry) => entry.fullId === tool)
        if (!entry) throw new Error("The actual Plugin Tool was not registered")
        const callID = "two-native-shell-calls"
        const args = { executable: process.execPath }
        const owner = RolloutLifecycle.owner(session)
        await RolloutLedger.beginRun(owner, rootID)
        let terminal: "completed" | "failed" = "failed"
        const failures: unknown[] = []
        async function rejectUnissued(origin: EnvironmentOrigin.Session, environmentID: string) {
          const selection = {
            scopeID: scope.id,
            workspaceID: session.workspaceID,
            workspaceGeneration: session.workspace?.generation,
            environmentID,
            origin,
            needs: { execution: "exec" as const },
          }
          phase("negative:first-resolve:start")
          await using resources = await EnvironmentResources.resolve(selection)
          phase("negative:first-resolve:done")
          phase("negative:other-resolve:start")
          await using other = await EnvironmentResources.resolve(selection)
          phase("negative:other-resolve:done")
          const directory = resources.directory
          if (!directory) throw new Error("The original native selection has no execution directory")
          const sandbox = (operationID: string) =>
            ExecutionProtocol.SandboxInput.parse({
              operationID,
              command: process.execPath,
              args: ["-e", "0"],
              workspace: directory,
              executionCwd: directory,
              sandboxMode: "none",
            })
          await EnvironmentResources.provide(resources, "plugin-shell-callback-negative", async () => {
            phase("negative:fabricated:start")
            await expect(
              EnvironmentResources.prepareSandbox(resources, sandbox("fabricated-child-operation")),
            ).rejects.toThrow()
            phase("negative:fabricated:done")
            const issued = EnvironmentResources.nextOperationID()
            phase("negative:other-resource:start")
            await expect(EnvironmentResources.prepareSandbox(other, sandbox(issued))).rejects.toThrow()
            phase("negative:other-resource:done")
          })
          phase("negative:escaped:start")
          const gate = Promise.withResolvers<void>()
          const escaped = await EnvironmentResources.provide(resources, "plugin-shell-callback-ended", async () => {
            const issued = EnvironmentResources.nextOperationID()
            return { late: gate.promise.then(() => EnvironmentResources.prepareSandbox(resources, sandbox(issued))) }
          })
          gate.resolve()
          await expect(escaped.late).rejects.toThrow()
          phase("negative:escaped:done")
          phase("negative:release:start")
          await Promise.all([resources.release(), other.release()])
          phase("negative:release:done")
          expect(await Environment.uses(environmentID)).toEqual([])
        }
        try {
          expect(EnvironmentResources.current()).toBeUndefined()
          const payload = z.object({ output: z.string() }).parse(
            await RolloutTool.execute({ owner, runID: rootID, messageID, toolCallID: callID, tool, args }, async () => {
              phase("actual-tool:start")
              const output = await entry.execute(args, {
                scopeId: scope.id,
                sessionID: session.id,
                messageID,
                callID,
                agent: PrimaryAgentIdentity.names.general,
                abort: new AbortController().signal,
              })
              phase("actual-tool:done")
              let original: EnvironmentExecution.Info | undefined
              for await (const info of EnvironmentExecution.entries())
                if (
                  info.origin.kind === "session" &&
                  info.origin.sessionID === session.id &&
                  info.origin.callID === callID
                )
                  original = info
              if (!original || original.origin.kind !== "session")
                throw new Error("The Plugin shells have no actual original Session execution")
              phase("negative:begin")
              await rejectUnissued(original.origin, original.target.environmentID)
              phase("negative:end")
              return output
            }),
          )
          const result = z.object({ first: ShellResult, second: ShellResult }).parse(JSON.parse(payload.output))
          terminal = "completed"
          expect(result.first).toEqual({ stdout: "first", stderr: "", exitCode: 0 })
          expect(result.second).toEqual({ stdout: "second", stderr: "", exitCode: 0 })
          expect(await Bun.file(path.join(temporary.path, "first.txt")).text()).toBe("first native effect")
          expect(await Bun.file(path.join(temporary.path, "second.txt")).text()).toBe("second native effect")
          const executions: EnvironmentExecution.Info[] = []
          for await (const info of EnvironmentExecution.entries())
            if (info.origin.kind === "session" && info.origin.sessionID === session.id && info.origin.callID === callID)
              executions.push(info)
          expect(executions).toHaveLength(2)
          expect(new Set(executions.map((info) => info.id)).size).toBe(2)
          for (const info of executions) {
            expect(info.state).toBe("completed")
            expect(info.origin).toEqual({
              kind: "session",
              scopeID: scope.id,
              sessionID: session.id,
              rootID,
              runID: rootID,
              messageID,
              callID,
              tool,
            })
            expect(await Environment.uses(info.target.environmentID)).toEqual([])
          }
        } catch (error) {
          failures.push(error)
        } finally {
          try {
            phase("cleanup:manager:start")
            await manager.stop(manifest.id)
            phase("cleanup:manager:done")
          } catch (error) {
            failures.push(error)
          }
          try {
            phase("cleanup:run:start")
            await RolloutLedger.finishRun(owner, rootID, terminal)
            phase("cleanup:run:done")
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length) console.error("Plugin sequence phase", JSON.stringify(phases))
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, "Two native Plugin shells and original cleanup failed")
      },
    })
  })
}, 15000)
