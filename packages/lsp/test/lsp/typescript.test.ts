import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LSP } from "../../src/index"
import { LSPServer } from "../../src/server"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test(
  "TypeScript 7 reports and clears diagnostics through the owned native language server",
  () =>
    runtime.run(async () => {
      const disabled = Object.fromEntries(
        Object.values(LSPServer)
          .filter((server) => server.id !== "typescript")
          .map((server) => [server.id, { disabled: true }]),
      )
      await using tmp = await tmpdir({ config: { lsp: disabled } })
      await fs.mkdir(path.join(tmp.path, "node_modules"))
      await fs.symlink(
        path.dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)),
        path.join(tmp.path, "node_modules/typescript"),
      )
      await Bun.write(path.join(tmp.path, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }))
      const file = path.join(tmp.path, "source.ts")
      await Bun.write(file, 'export const value: number = "wrong"\n')
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          try {
            await LSP.touchFile(file, true)
            expect((await LSP.diagnostics())[file]).toEqual(
              expect.arrayContaining([expect.objectContaining({ code: 2322 })]),
            )
            expect(await LSP.hover({ file, line: 0, character: 14 })).not.toEqual([])
            await Bun.write(file, "export const value: number = 42\n")
            await LSP.touchFile(file, true)
            expect((await LSP.diagnostics())[file] ?? []).toEqual([])
          } finally {
            await LSP.reload()
          }
        },
      })
    }),
  20000,
)

test("TypeScript 6 projects retain their project-local tsserver", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const tsserver = path.join(tmp.path, "node_modules/typescript/lib/tsserver.js")
    await Bun.write(tsserver, "")
    await Bun.write(
      path.join(tmp.path, "node_modules/typescript/package.json"),
      JSON.stringify({ name: "typescript", version: "6.0.2" }),
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect((await LSPServer.Typescript.resolve(tmp.path))?.initialization).toEqual({ tsserver: { path: tsserver } })
      },
    })
  }))
