import { expect, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentProviders } from "../../src/environment/provider"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { migrateSessionEnvironment } from "../../src/environment/migration"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { Tool } from "../../src/tool/tool"
import { z } from "zod"

test("Sessions select and inherit an Environment without allocating compute", async () => {
  let allocations = 0
  await using runtime = await testRuntime({
    register() {
      EnvironmentProviders.register({
        id: "fixture",
        async allocate(request) {
          allocations++
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect() {
          return { state: "absent" }
        },
        async deallocate() {},
      })
      EnvironmentProviders.setDefault({ provider: "fixture", spec: {} })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const scope = Scope.home()
        const parent = await Session.create({ scope, workspace: null })
        const child = await Session.create({ parentID: parent.id })
        const fork = await Session.fork({ sessionID: parent.id })
        const detached = await Session.create({ parentID: parent.id, environmentID: null })
        expect(parent.environmentID).toStartWith("env_")
        expect(child.environmentID).toBe(parent.environmentID)
        expect(fork.environmentID).toBe(parent.environmentID)
        expect(detached.environmentID).toBeNull()
        expect((await Session.get(child.id)).environmentID).toBe(parent.environmentID)
        expect((await Environment.get(parent.environmentID!, scope.id)).state).toBe("idle")
        expect(allocations).toBe(0)
        await SessionManager.run(parent.id, async () => "API call")
        expect(allocations).toBe(0)
        const imported = await SessionImport.fromReport(
          await SessionExport.generate({ sessionID: parent.id, mode: "full" }),
        )
        expect(imported.sessions.every(({ session }) => session.environmentID === null)).toBe(true)
        const key = ["sessions", scope.id, child.id, "info"]
        const { environmentID: _old, ...legacy } = await Storage.read<Session.Info>(key)
        await Storage.write(key, legacy)
        const owner = { scopeID: scope.id, sessionID: child.id }
        expect(await migrateSessionEnvironment(owner)).toBe(parent.environmentID!)
        expect(await migrateSessionEnvironment(owner)).toBe(parent.environmentID!)
        expect(allocations).toBe(0)
      },
    }),
  )
})

test("file tool use still rejects imported local paths before side effects", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const source = await WorkspaceCatalog.register({
          scopeID: Scope.home().id,
          type: "directory",
          hostID: "source",
          path: runtime.host.root,
        })
        const imported = await WorkspaceCatalog.importRecord(source)
        let effects = 0
        const tool = await Tool.define(
          "fixture",
          {
            description: "fixture",
            parameters: z.object({}),
            async execute() {
              effects++
              return { title: "fixture", output: "done", metadata: {} }
            },
          },
          { requiresWorkspace: true },
        ).init()
        const session = await Session.create({ workspaceID: imported.id })
        await SessionManager.run(session.id, async () => {
          await expect(
            tool.execute(
              {},
              {
                sessionID: session.id,
                messageID: "message",
                agent: "fixture",
                abort: new AbortController().signal,
                metadata() {},
                async ask() {},
              },
            ),
          ).rejects.toThrow("binding")
        })
        expect(effects).toBe(0)
      },
    }),
  )
})

test("an API-only Runtime runs Sessions with an unavailable Workspace and no Environment", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const scope = Scope.home()
        const workspace = await WorkspaceCatalog.importMissingReference("wsp_unavailable", scope.id)
        const session = await Session.create({ scope, workspaceID: workspace.id })
        expect(session.environmentID).toBeNull()
        expect(await SessionManager.run(session.id, async () => "business API result")).toBe("business API result")
        await expect(Session.assertWorkspaceAvailable(session.id)).rejects.toThrow()
      },
    }),
  )
})
