import { describe, expect, test } from "bun:test"
import path from "path"
import { ViewFileTool } from "../../src/tool/view-file"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-hashline-bin",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.view_file binary file blocking", () => {
  test("rejects .pdf files with 'Cannot read binary file' error", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Minimal valid PDF header — just enough to make it not an empty file
        await Bun.write(path.join(dir, "doc.pdf"), "%PDF-1.4\n%EOF\n")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "doc.pdf") }, ctx)).rejects.toThrow(
          /Cannot read binary file/,
        )
      },
    })
  })

  test("rejects .docx files with 'Cannot read binary file' error", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "report.docx"), "PK\u0003\u0004")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "report.docx") }, ctx)).rejects.toThrow(
          /Cannot read binary file/,
        )
      },
    })
  })

  test("rejects .xlsx files with 'Cannot read binary file' error", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "sheet.xlsx"), "PK\u0003\u0004")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "sheet.xlsx") }, ctx)).rejects.toThrow(
          /Cannot read binary file/,
        )
      },
    })
  })

  test("rejects .pptx files with 'Cannot read binary file' error", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "deck.pptx"), "PK\u0003\u0004")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "deck.pptx") }, ctx)).rejects.toThrow(
          /Cannot read binary file/,
        )
      },
    })
  })

  test("rejects .exe files with 'Cannot read binary file' error", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "app.exe"), "MZ\x90\x00")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "app.exe") }, ctx)).rejects.toThrow(
          /Cannot read binary file/,
        )
      },
    })
  })

  test("rejects .dll files with 'Cannot read binary file' error", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "lib.dll"), "MZ\x90\x00")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "lib.dll") }, ctx)).rejects.toThrow(
          /Cannot read binary file/,
        )
      },
    })
  })

  test("rejects .so files with 'Cannot read binary file' error", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "lib.so"), "\x7fELF")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "lib.so") }, ctx)).rejects.toThrow(
          /Cannot read binary file/,
        )
      },
    })
  })

  test("still reads plain text files normally", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "notes.txt"), "meeting notes here\n")
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "notes.txt") }, ctx)
        expect(result.output).toContain("notes.txt")
        expect(result.output).not.toContain("Cannot read binary")
        expect(result.metadata.tag).toBeDefined()
      },
    })
  })
})
