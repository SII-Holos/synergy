import { describe, expect, test } from "bun:test"
import path from "path"
import { ParseCodeTool } from "../../src/tool/parse-code"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { computeTag } from "../../src/hashline/tag"

const ctx = {
  sessionID: "test-hashline-parse",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.parse_code", () => {
  describe("AST search with hashline output", () => {
    test("groups AST search results by file with hashline headers", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "test.ts"),
            [
              "export function greet(name: string): string {",
              '  return "Hello " + name',
              "}",
              "",
              "export function farewell(name: string): string {",
              '  return "Goodbye " + name',
              "}",
              "",
            ].join("\n"),
          )
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ParseCodeTool.init()
          const result = await tool.execute(
            { pattern: "export function $NAME($$$): string { $$$ }", lang: "typescript" },
            ctx,
          )

          // Has hashline header
          expect(result.output).toMatch(/\[test\.ts#[0-9A-F]{4}\]/)
          // Full file snapshot in hashline format
          expect(result.output).toContain("1:export function greet")
          expect(result.output).toContain("5:export function farewell")
          expect(result.metadata.matches).toBeGreaterThanOrEqual(2)
        },
      })
    })

    test("each matched file is snapshotted as a full hashline block", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "lib.ts"),
            ["const x = console.log('hello')", "const y = console.log('world')", ""].join("\n"),
          )
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ParseCodeTool.init()
          const result = await tool.execute({ pattern: "console.log($MSG)", lang: "typescript" }, ctx)

          const fileContent = "const x = console.log('hello')\nconst y = console.log('world')\n"
          expect(result.output).toContain(`[lib.ts#${computeTag(fileContent)}]`)
          // Lines following header should be the file content without inventing a trailing blank row.
          expect(result.output).toContain("1:const x")
          expect(result.output).toContain("2:const y")
          expect(result.output).not.toContain("3:")
        },
      })
    })

    test("tag is content-derived, not a counter", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "simple.ts"), "const x = 1\n")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ParseCodeTool.init()
          const result = await tool.execute({ pattern: "const $X = $Y", lang: "typescript" }, ctx)

          // Tag should be derived from the file content
          const expectedTag = computeTag("const x = 1\n")
          expect(result.output).toContain(`[simple.ts#${expectedTag}]`)
        },
      })
    })
  })

  describe("no matches handling", () => {
    test("returns guidance when no structural matches are found", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "test.ts"), "const x = 1\n")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ParseCodeTool.init()
          const result = await tool.execute({ pattern: "someNonexistentPattern($$$)", lang: "typescript" }, ctx)

          expect(result.metadata.matches).toBe(0)
          expect(result.output).toContain("No structural matches found")
          expect(result.output).toContain("If you are searching for a literal or partial fragment, use scan_files")
        },
      })
    })

    test("guides the agent when the AST pattern is incomplete", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "dag.ts"), "export namespace Dag {\n  export const x = 1\n}\n")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ParseCodeTool.init()
          const result = await tool.execute({ pattern: "export namespace Dag {", lang: "typescript" }, ctx)

          expect(result.metadata.matches).toBe(0)
          expect(result.output).toContain("The AST pattern is not parseable")
          expect(result.output).toContain("export namespace $NAME { $$$ }")
          expect(result.output).toContain("scan_files")
        },
      })
    })
  })

  describe("multiple files", () => {
    test("returns separate hashline blocks for different files", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
          await Bun.write(path.join(dir, "b.ts"), "export function b() { return 2 }\n")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ParseCodeTool.init()
          const result = await tool.execute({ pattern: "export function $NAME($$$) { $$$ }", lang: "typescript" }, ctx)

          expect(result.output).toMatch(/AST matches in \[a\.ts#[0-9A-F]{4}\]: 1:/)
          expect(result.output).toMatch(/AST matches in \[a\.ts#[0-9A-F]{4}\]: 1:/)
          expect(result.output).toContain("1:export function a")
          expect(result.output).toMatch(/AST matches in \[b\.ts#[0-9A-F]{4}\]: 1:/)
          expect(result.output).toMatch(/AST matches in \[b\.ts#[0-9A-F]{4}\]: 1:/)
          expect(result.output).toContain("1:export function b")
        },
      })
    })
  })

  describe("metadata", () => {
    test("reports match count and snapshotted files", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "code.ts"),
            ["export const a = 1", "export const b = 2", "const c = 3", ""].join("\n"),
          )
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ParseCodeTool.init()
          const result = await tool.execute({ pattern: "export const $NAME = $VALUE", lang: "typescript" }, ctx)

          expect(result.metadata.matches).toBe(2)
          expect(result.metadata.files).toContain("code.ts")
          expect(result.metadata.matchLines["code.ts"]).toEqual([1, 2])
          expect(result.metadata.matchRanges["code.ts"]).toHaveLength(2)
        },
      })
    })
  })
})
