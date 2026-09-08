import { describe, expect, test, beforeEach } from "bun:test"
import { spawn } from "child_process"
import path from "path"
import { LSPClient } from "../../src/lsp/client"
import { LSPServer } from "../../src/lsp/server"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

// Minimal fake LSP server that speaks JSON-RPC over stdio
function spawnFakeServer() {
  const serverPath = path.join(__dirname, "../../../testing/test/lsp/fake-lsp-server.cjs")
  const runtime = Bun.which("node") ?? process.execPath
  return {
    process: spawn(runtime, [serverPath], {
      stdio: "pipe",
    }),
  }
}

describe("LSPClient interop", () => {
  beforeEach(async () => {
    await Log.init({ print: true })
  })

  test("handles workspace/workspaceFolders request", async () => {
    const handle = spawnFakeServer() as any

    const client = await ScopeContext.provide({
      scope: (await Scope.fromDirectory(process.cwd())).scope,
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "workspace/workspaceFolders",
    })

    await new Promise((r) => setTimeout(r, 500))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("handles client/registerCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await ScopeContext.provide({
      scope: (await Scope.fromDirectory(process.cwd())).scope,
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/registerCapability",
    })

    await new Promise((r) => setTimeout(r, 500))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("handles client/unregisterCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await ScopeContext.provide({
      scope: (await Scope.fromDirectory(process.cwd())).scope,
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/unregisterCapability",
    })

    await new Promise((r) => setTimeout(r, 500))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })
})
