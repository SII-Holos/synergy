import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { openLocalRuntime, RuntimeHandle, createLocalStorage, registerLocalRuntime } from "../src"
import { submitInput } from "../src/session-api"

test("Home and explicit none retain a null workspace through creation and child inheritance", async () => {
  await using fixture = await runtimeHome()
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        expect(Scope.home()).toEqual({ type: "home", id: "home", local: null })
        const parent = await Session.create()
        expect(parent.workspace).toBeNull()
        expect((await Session.create({ parentID: parent.id })).workspace).toBeNull()
        await expect(Session.applyWorkspaceSelection(parent.id, { mode: "current" })).rejects.toThrow("workspace")
      },
    }),
  )
  const directory = path.join(fixture.host.home, "project")
  await fs.mkdir(directory)
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(directory)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create()
        expect(parent.workspace).toEqual({ type: "main", path: directory, scopeID: scope.id })
        await ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const inherited = await Session.create({ parentID: parent.id })
            expect(inherited.scope.id).toBe(scope.id)
            expect(inherited.workspace).toEqual(parent.workspace)
            const moved = await Session.create({ parentID: parent.id, scope: Scope.home() })
            expect(moved.workspace).toBeNull()
          },
        })
        await Session.applyWorkspaceSelection(parent.id, { mode: "none" })
        const child = await Session.create({ parentID: parent.id })
        expect(child.workspace).toBeNull()
        await ScopeContext.provide({
          scope,
          workspace: parent.workspace,
          fn: async () => {
            await ScopeContext.provide({
              scope: Scope.home(),
              workspace: null,
              fn: () => {
                expect(ScopeContext.current.workspace).toBeNull()
                expect(() => ScopeContext.current.directory).toThrow("workspace")
              },
            })
          },
        })
      },
    })
  })
})

test("a missing project remains readable and a rejected submission does not persist input or rebind its workspace", async () => {
  await using fixture = await runtimeHome()
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  const directory = path.join(fixture.host.home, "project")
  await fs.mkdir(directory)
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(directory)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Keep this history" })
        await fs.rm(directory, { recursive: true })
        expect((await Scope.fromID(scope.id))?.id).toBe(scope.id)
        expect((await Scope.list()).map((item) => item.id)).toContain(scope.id)
        for (const noReply of [false, true]) {
          await expect(
            submitInput({ sessionID: session.id, noReply, parts: [{ type: "text", text: "Do not accept" }] }),
          ).rejects.toThrow("available")
        }
        expect((await Session.messages({ sessionID: session.id })).length).toBe(0)
        expect((await Session.get(session.id)).workspace).toEqual(session.workspace)
        await Scope.remove(scope.id)
        expect((await Scope.fromID(scope.id))?.id).toBe(scope.id)
        expect((await Session.get(session.id)).title).toBe("Keep this history")
        await expect(Scope.fromDirectory(directory)).rejects.toThrow("available")
      },
    })
  })
})

test("file tools are undiscoverable without a workspace and a previously obtained tool cannot bypass the resource check", async () => {
  await using fixture = await runtimeHome()
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  const file = path.join(fixture.host.home, "private.txt")
  await Bun.write(file, "do not read without a binding")
  const { ToolRegistry } = await import("@ericsanchezok/synergy-harness/tool/registry")
  const { ReadTool } = await import("../src/tools/read")
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(fixture.host.home)
    const prepared = await ScopeContext.provide({ scope, fn: () => ReadTool.init() })
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ controlProfile: "full_access" })
        expect(await ToolRegistry.find("read")).toBeUndefined()
        expect((await ToolRegistry.ids()).includes("session_read")).toBe(true)
        await expect(
          prepared.execute(
            { filePath: file },
            {
              sessionID: session.id,
              messageID: "msg_test",
              agent: "synergy",
              abort: new AbortController().signal,
              metadata() {},
              async ask() {
                throw new Error("Resource availability must be checked before permissions")
              },
            },
          ),
        ).rejects.toMatchObject({ name: "WorkspaceRequired" })
      },
    })
  })
})

test("plugin workspace metadata controls discovery and remains enforced on a retained executable", async () => {
  const { ToolPluginSource } = await import("@ericsanchezok/synergy-harness/tool/plugin-source")
  const { ToolRegistry } = await import("@ericsanchezok/synergy-harness/tool/registry")
  await using fixture = await runtimeHome()
  let executions = 0
  await using runtime = await RuntimeHandle.open({
    host: fixture.host,
    mode: "oneshot",
    storage: createLocalStorage(fixture.host),
    composition: {
      register() {
        registerLocalRuntime()
        ToolPluginSource.register({
          async conditionEnabled() {
            return true
          },
          async toolEntries() {
            return [true, false].map((requiresWorkspace) => ({
              fullId: requiresWorkspace ? "plugin__test__file" : "plugin__test__network",
              pluginId: "test",
              toolId: requiresWorkspace ? "file" : "network",
              pluginDir: fixture.host.home,
              description: "Test a declared resource dependency",
              inputSchema: { type: "object", properties: {} },
              requiresWorkspace,
              async execute(_args, ctx) {
                executions++
                return { output: ctx.directory ?? "network result" }
              },
            }))
          },
        })
      },
    },
  })
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(fixture.host.home)
    const local = await ScopeContext.provide({ scope, fn: () => ToolRegistry.find("plugin__test__file") })
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ controlProfile: "full_access" })
        const context = {
          sessionID: session.id,
          messageID: "msg_test",
          agent: "synergy",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        }
        expect(await ToolRegistry.find("plugin__test__file")).toBeUndefined()
        await expect(local!.execute({}, context)).rejects.toMatchObject({ name: "WorkspaceRequired" })
        const network = await ToolRegistry.find("plugin__test__network")
        expect((await network!.execute({}, context)).output).toBe("network result")
        expect(executions).toBe(1)
      },
    })
  })
})

test("custom tools with the same name remain owned by their Scope", async () => {
  const { ToolRegistry } = await import("@ericsanchezok/synergy-harness/tool/registry")
  const { Tool } = await import("@ericsanchezok/synergy-harness/tool/tool")
  const { z } = await import("zod")
  await using fixture = await runtimeHome()
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  await runtime.run(async () => {
    const scopes = []
    for (const name of ["a", "b"]) {
      const directory = path.join(fixture.host.home, name)
      await fs.mkdir(directory)
      const { scope } = await Scope.fromDirectory(directory)
      scopes.push(scope)
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await ToolRegistry.register(
            Tool.define("fixture_tool", {
              description: name,
              parameters: z.object({}),
              async execute() {
                return { title: name, output: name, metadata: {} }
              },
            }),
          )
          expect((await ToolRegistry.find("fixture_tool"))?.description).toBe(name)
        },
      })
    }
    await ScopeContext.provide({
      scope: scopes[0]!,
      fn: async () => {
        expect((await ToolRegistry.find("fixture_tool"))?.description).toBe("a")
      },
    })
  })
})

test("terminal creation cannot borrow a Scope directory for a session without a workspace", async () => {
  const { Pty } = await import("../src/process/pty")
  await using fixture = await runtimeHome()
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(fixture.host.home)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await expect(
          Pty.create({ sessionID: session.id, cwd: fixture.host.home, command: "__missing_fixture_command__" }),
        ).rejects.toMatchObject({ name: "WorkspaceRequired" })
        expect(Pty.list()).toEqual([])
      },
    })
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await expect(
          Pty.create({ cwd: fixture.host.home, command: "__missing_fixture_command__" }),
        ).rejects.toMatchObject({ name: "WorkspaceRequired" })
      },
    })
  })
})

test("changing a session to none releases its terminal before returning", async () => {
  const { Pty } = await import("../src/process/pty")
  await using fixture = await runtimeHome()
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(fixture.host.home)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create()
        const terminal = await Pty.create({ sessionID: session.id, command: "/bin/cat" })
        expect(terminal.cwd).toBe(session.workspace!.path)
        expect(Pty.get(terminal.id)).toBeDefined()
        await Session.updateWorkspace(session.id, null, { requireIdle: true })
        expect(Pty.get(terminal.id)).toBeUndefined()
        expect((await Session.get(session.id)).workspace).toBeNull()
      },
    })
  })
})
