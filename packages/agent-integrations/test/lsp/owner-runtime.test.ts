import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LSP } from "../../src/lsp"
import { LSPServer } from "../../src/lsp/server"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("configured LSP owner starts a real protocol process, reuses it for queries and releases it on reload", () =>
  runtime.run(async () => {
    const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
    await using tmp = await tmpdir({
      config: {
        lsp: {
          ...disabled,
          fixture: {
            command: [process.execPath, path.join(import.meta.dir, "fixtures/owner-server.cjs")],
            extensions: [".fixture"],
          },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        try {
          const file = path.join(tmp.path, "source.fixture")
          await Bun.write(file, "let ownerSymbol = 1")
          expect(await LSP.hasClients(file)).toBe(true)
          expect(await LSP.hasClients(path.join(tmp.path, "other.unconfigured"))).toBe(false)
          expect(await LSP.status()).toEqual([])
          await LSP.touchFile(file, true)
          expect(await LSP.status()).toEqual([{ id: "fixture", name: "fixture", root: "", status: "connected" }])
          expect((await LSP.diagnostics())[file]?.[0]?.message).toBe("fixture warning")
          const input = { file, line: 0, character: 1 }
          expect(await LSP.hover(input)).toEqual([{ contents: "fixture hover" }])
          expect(await LSP.definition(input)).toEqual([
            {
              uri: pathToFileURL(file).href,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ])
          expect(await LSP.references(input)).toHaveLength(1)
          expect(await LSP.implementation(input)).toHaveLength(1)
          expect(await LSP.documentSymbol(pathToFileURL(file).href)).toHaveLength(1)
          expect(await LSP.workspaceSymbol("symbol")).toHaveLength(10)
          expect(await LSP.prepareCallHierarchy(input)).toHaveLength(1)
          expect(await LSP.incomingCalls(input)).toHaveLength(1)
          expect(await LSP.outgoingCalls(input)).toHaveLength(1)
          expect(await LSP.status()).toHaveLength(1)
          await LSP.reload()
          expect(await LSP.status()).toEqual([])
        } finally {
          await LSP.reload()
        }
      },
    })
  }))

test("starting another Workspace preserves active LSP processes and independent diagnostics", () =>
  runtime.run(async () => {
    const { Session } = await import("@ericsanchezok/synergy-harness/session")
    const { ProcessInspection } = await import("@ericsanchezok/synergy-harness/process/inspection")
    const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
    await using first = await tmpdir({
      config: {
        lsp: {
          ...disabled,
          fixture: {
            command: [
              process.execPath,
              "-e",
              "await Bun.write('server.pid',String(process.pid));await import(process.argv[1])",
              path.join(import.meta.dir, "fixtures/owner-server.cjs"),
            ],
            extensions: [".fixture"],
          },
        },
      },
    })
    await using second = await tmpdir()
    const scope = await first.scope()
    const sessions = await ScopeContext.provide({
      scope,
      fn: async () => [
        await Session.create({}),
        await Session.create({ workspace: { type: "directory", scopeID: scope.id, path: second.path } }),
      ],
    })
    try {
      for (const session of sessions)
        await ScopeContext.provide({
          scope,
          workspace: session.workspace,
          fn: async () => {
            const file = path.join(session.workspace!.path, "source.fixture")
            await Bun.write(file, "let symbol = 1")
            await LSP.touchFile(file, true)
            expect(Object.keys(await LSP.diagnostics())).toEqual([file])
          },
        })
      const pids = await Promise.all(
        [first, second].map(async (directory) =>
          Number(await Bun.file(path.join(directory.path, "server.pid")).text()),
        ),
      )
      expect(pids[0]).not.toBe(pids[1])
      for (const pid of pids) expect(ProcessInspection.alive(pid)).toBe(true)
    } finally {
      await LSP.reload()
    }
  }))

afterRuntimeTests(() => runtime.close())
