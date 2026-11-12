import { expect, test } from "bun:test"
import path from "node:path"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { RolloutContext } from "@ericsanchezok/synergy-harness/session/rollout/context"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ToolPluginSource } from "@ericsanchezok/synergy-harness/tool/plugin-source"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { state as pluginState } from "../../src/plugin/loader"
import { PluginToolId } from "../../src/plugin/ids"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import { registerToolPluginSource } from "../../src/plugin/tool-source"
import { pluginContributionAdapters } from "../../src/plugin/contribution-registry"
import definition from "./fixtures/origin-plugin"
import { testRuntime } from "../support/runtime"

test("a process plugin Tool without eager Workspace resources retains the canonical native tool origin", async () => {
  const observed: (Readonly<EnvironmentOrigin.Current> | undefined)[] = []
  await using runtime = await testRuntime({
    register() {
      registerToolPluginSource()
      WorkspaceBlobs.register("plugin-origin", {
        put: (hash, bytes) => Storage.writeBinary(["plugin-origin", hash], bytes),
        get: (hash) => {
          observed.push(EnvironmentResources.current()?.origin?.value)
          return Storage.readBinary(["plugin-origin", hash])
        },
      })
    },
  })
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({
          scopeID: scope.id,
          backend: { provider: "objects", spec: { blobStore: "plugin-origin" } },
        })
        await WorkspaceContent.write(
          { scopeID: scope.id, workspaceID: workspace.id },
          { path: "file.txt", data: new TextEncoder().encode("native bytes"), expectedVersion: null },
        )
        const session = await Session.create({ workspaceID: workspace.id, environmentID: null })
        const rootID = Identifier.ascending("message")
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          rootID,
          isRoot: true,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: 1 },
        })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: rootID,
          rootID,
          agent: "general",
          providerID: "fixture",
          modelID: "fixture",
          mode: "default",
          path: { cwd: null, root: null },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2 },
        })
        const owner = RolloutLifecycle.owner(session)
        await RolloutLedger.beginRun(owner, rootID)
        const tool = PluginToolId.format(definition.id, "read")
        const callID = "actual-native-call"
        await RolloutLedger.beginTool({ owner, runID: rootID, messageID, toolCallID: callID, tool, args: {} })
        const manifest = compilePluginManifest(definition, {
          generation: "native-origin",
          runtime: { entry: "runtime/index.js", sha256: "fixture" },
        })
        const entryPath = path.join(import.meta.dir, "fixtures", "origin-plugin.ts")
        const manager = pluginRuntimeManager()
        const catalog = await pluginState()
        catalog.loaded.push({
          id: manifest.id,
          name: "Origin fixture",
          manifest,
          pluginDir: path.dirname(entryPath),
          entryPath,
          source: "builtin",
          spec: "origin-fixture",
          enabledScopes: new Set([scope.id]),
          contributionHealth: new Map(),
        })
        pluginContributionAdapters().registerPlugin(manifest.id, manifest)
        const source = ToolPluginSource.get()
        if (!source) throw new Error("Plugin Tool source was not composed")
        const entry = (await source.toolEntries()).find((entry) => entry.fullId === tool)
        if (!entry) throw new Error("Native plugin Tool is unavailable")
        const context = {
          scopeId: scope.id,
          sessionID: session.id,
          messageID,
          callID,
          userMessageID: "untrusted-display-label",
          agent: "general",
          abort: new AbortController().signal,
        }
        try {
          expect(EnvironmentResources.current()).toBeUndefined()
          const value = await RolloutContext.provide({ owner, runID: rootID }, () =>
            entry.execute({ path: "file.txt" }, context),
          )
          expect(value).toBe("native bytes")
          expect(observed.length).toBeGreaterThan(0)
          expect(observed.every((origin) => origin?.kind === "session")).toBe(true)
          const expected: EnvironmentOrigin.Session = {
            kind: "session",
            scopeID: scope.id,
            sessionID: session.id,
            rootID,
            runID: rootID,
            messageID,
            callID,
            tool,
          }
          expect(observed[0]).toEqual(expected)
          await using resources = await EnvironmentResources.resolve({
            scopeID: scope.id,
            workspaceID: workspace.id,
            workspaceGeneration: workspace.binding.generation,
            origin: expected,
            needs: { workspace: true },
          })
          const invoke = (sessionID = session.id) =>
            manager.invoke({
              pluginId: manifest.id,
              handlerId: "operation:read",
              value: { path: "file.txt" },
              context: { scopeId: scope.id, sessionId: sessionID, actor: { type: "ui" } },
              pluginDir: path.dirname(entryPath),
              manifest,
            })
          observed.length = 0
          expect(await EnvironmentResources.provide(resources, "inherited", invoke)).toBe("native bytes")
          expect(observed.length).toBeGreaterThan(0)
          expect(observed.every((origin) => origin === resources.origin?.value)).toBe(true)

          const other = await Session.create({ workspaceID: workspace.id, environmentID: null })
          observed.length = 0
          await expect(
            EnvironmentResources.provide(resources, "foreign-session", () => invoke(other.id)),
          ).rejects.toThrow("original Session")
          expect(observed).toEqual([])

          observed.length = 0
          await expect(
            EnvironmentResources.provide({ ...resources, origin: undefined }, "missing-origin", invoke),
          ).rejects.toThrow("original resource origin")
          expect(observed).toEqual([])
          await expect(
            RolloutContext.provide({ owner, runID: rootID }, () =>
              entry.execute({ path: "file.txt" }, { ...context, callID: "display-call-label" }),
            ),
          ).rejects.toThrow("canonical native")
          await expect(
            RolloutContext.provide({ owner, runID: rootID }, () =>
              entry.execute({ path: "file.txt" }, { ...context, callID: undefined }),
            ),
          ).rejects.toThrow("native Session, Run and call identity")
          expect(observed).toEqual([])

          expect(await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })).toBe(true)
          await expect(
            RolloutContext.provide({ owner, runID: rootID }, () => entry.execute({ path: "file.txt" }, context)),
          ).rejects.toThrow("cannot start another native effect")
          expect(observed).toEqual([])
          expect(await invoke()).toBe("native bytes")
          expect(observed.every((origin) => origin?.kind === "host" && origin.owner === "plugin-host")).toBe(true)
        } finally {
          await manager.stop(manifest.id)
        }
      },
    })
  })
}, 15_000)
