import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LSP } from "../../src/lsp"
import { LSPServer } from "../../src/lsp/server"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("configured LSP owner starts a real protocol process, reuses it for queries and releases it on reload", async () => {
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
})
