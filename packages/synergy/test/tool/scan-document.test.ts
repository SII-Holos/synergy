import { describe, expect, test } from "bun:test"
import path from "path"
import { ScanDocumentTool } from "../../src/tool/scan-document"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { createPptx } from "../fixture/pptx"

const ctx = {
  sessionID: "test-scan-doc",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

const DOCUMENT_TEST_TIMEOUT_MS = 15_000

function csvContent(rows: number): string {
  const lines = ["col1,col2,col3"]
  for (let i = 0; i < rows - 1; i++) {
    lines.push(`val${i}a,val${i}b,val${i}c`)
  }
  return lines.join("\n") + "\n"
}

describe("tool.scan_document", () => {
  describe("basic extraction", () => {
    test(
      "extracts a .csv file and returns markdown output",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "data.csv"), "name,age\nAlice,30\nBob,25\n")
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const result = await tool.execute({ filePath: path.join(tmp.path, "data.csv") }, ctx)

            expect(result.output).toBeTruthy()
            expect(result.output).toMatch(/^1:/m)
            expect(result.output).toContain("name")
            expect(result.metadata.documentKind).toBe("csv")
            expect(result.metadata.filePath).toBe(path.join(tmp.path, "data.csv"))
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )

    test(
      "extracts slide text from a .pptx file",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "slides.pptx"), await createPptx(["Quarterly update", "Next steps"]))
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const result = await tool.execute({ filePath: path.join(tmp.path, "slides.pptx") }, ctx)

            expect(result.output).toContain("[Slide 1]")
            expect(result.output).toContain("Quarterly update")
            expect(result.output).toContain("[Slide 2]")
            expect(result.output).toContain("Next steps")
            expect(result.metadata.documentKind).toBe("pptx")
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )

    test(
      "extracts a .csv file and returns valid metadata",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "inventory.csv"), "sku,qty\nABC,10\nDEF,20\n")
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const result = await tool.execute({ filePath: path.join(tmp.path, "inventory.csv") }, ctx)

            expect(result.metadata.filePath).toBe(path.join(tmp.path, "inventory.csv"))
            expect(result.metadata.documentKind).toBe("csv")
            expect(typeof result.metadata.title === "string" || result.metadata.title === null).toBe(true)
            expect(result.metadata.totalLines).toBeGreaterThan(0)
            expect(result.metadata.totalBytes).toBeGreaterThan(0)
            expect(result.metadata.offset).toBe(0)
            expect(result.metadata.returned).toBeGreaterThan(0)
            expect(typeof result.metadata.truncated).toBe("boolean")
            expect(typeof result.metadata.truncatedByBytes).toBe("boolean")
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )
  })

  describe("offset and limit pagination", () => {
    test(
      "offset skips lines correctly",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "paged.csv"), csvContent(16))
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const result = await tool.execute({ filePath: path.join(tmp.path, "paged.csv"), offset: 3 }, ctx)

            expect(result.metadata.offset).toBe(3)
            // Offset 3 means first output line should be 3:...
            expect(result.output).toMatch(/^4:/m)
            // Lines 0-2 should not appear at start of any output line
            expect(result.output).not.toMatch(/^0:/m)
            expect(result.output).not.toMatch(/^1:/m)
            expect(result.output).not.toMatch(/^2:/m)
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )

    test(
      "limit caps returned line count",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "limited.csv"), csvContent(30))
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const result = await tool.execute({ filePath: path.join(tmp.path, "limited.csv"), limit: 5 }, ctx)

            expect(result.metadata.limit).toBe(5)
            expect(result.metadata.returned).toBeLessThanOrEqual(5)
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )
  })

  describe("truncation", () => {
    test(
      "truncated flag is true when document has more lines",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "large.csv"), csvContent(100))
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const result = await tool.execute({ filePath: path.join(tmp.path, "large.csv"), limit: 10 }, ctx)

            expect(result.metadata.truncated).toBe(true)
            expect(result.output).toContain("Document has more lines")
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )

    test(
      "truncated flag is false when file fits completely",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "small.csv"), csvContent(3))
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const result = await tool.execute({ filePath: path.join(tmp.path, "small.csv") }, ctx)

            expect(result.metadata.truncated).toBe(false)
            expect(result.output).toContain("End of document")
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )
  })

  describe("error handling", () => {
    test(
      "throws clear error for unsupported .exe extension",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "program.exe"), "binary")
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            await expect(tool.execute({ filePath: path.join(tmp.path, "program.exe") }, ctx)).rejects.toThrow(
              /does not support/,
            )
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )

    test(
      "throws clear error for unsupported .dll extension",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "lib.dll"), "binary")
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            await expect(tool.execute({ filePath: path.join(tmp.path, "lib.dll") }, ctx)).rejects.toThrow(
              /does not support/,
            )
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )

    test(
      "throws for file not found",
      async () => {
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            await expect(tool.execute({ filePath: path.join(tmp.path, "nonexistent.csv") }, ctx)).rejects.toThrow(
              /File not found/,
            )
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )

    test(
      "throws clear error for unsupported .so extension",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "lib.so"), "binary")
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            await expect(tool.execute({ filePath: path.join(tmp.path, "lib.so") }, ctx)).rejects.toThrow(
              /does not support/,
            )
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )

    test(
      "handles extraction result that may return null",
      async () => {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "bad.csv"), "\x00\x01\x02")
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const promise = tool.execute({ filePath: path.join(tmp.path, "bad.csv") }, ctx)
            const result = await promise.catch((err) => err)
            if (result instanceof Error) {
              expect(result.message).toMatch(/extract|could not/i)
            } else {
              expect(result.output).toBeTruthy()
            }
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )
  })

  describe("external_directory permission", () => {
    test(
      "does not emit external_directory directly when reading outside project",
      async () => {
        await using outerTmp = await tmpdir({
          init: async (dir) => {
            await Bun.write(path.join(dir, "external.csv"), "a,b\n1,2\n")
          },
        })
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await ScanDocumentTool.init()
            const requests: Array<Record<string, unknown>> = []
            const testCtx = {
              ...ctx,
              ask: async (req: Record<string, unknown>) => {
                requests.push(req)
              },
            }
            await tool.execute({ filePath: path.join(outerTmp.path, "external.csv") }, testCtx as any)
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeUndefined()
          },
        })
      },
      DOCUMENT_TEST_TIMEOUT_MS,
    )
  })
})
