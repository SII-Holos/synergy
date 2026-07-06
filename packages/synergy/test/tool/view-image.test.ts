import { describe, expect, test } from "bun:test"
import path from "path"
import { ViewImageTool } from "../../src/tool/view-image"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
)

const ctx = {
  sessionID: "ses_test123",
  messageID: "msg_test123",
  callID: "call_test123",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.view_image", () => {
  test("returns a provider-file image attachment for a PNG", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "image.png"), PNG_BYTES)
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const viewImage = await ViewImageTool.init()
        const filepath = path.join(tmp.path, "image.png")
        const result = await viewImage.execute({ filePath: filepath }, ctx)

        expect(result.title).toBe("Viewed Image: image.png")
        expect(result.output).toContain("loaded into the current model context")
        expect(result.metadata).toMatchObject({
          filePath: filepath,
          filename: "image.png",
          mimeType: "image/png",
          modelContext: true,
          truncated: false,
        })
        expect(result.metadata.sizeBytes).toBeGreaterThan(0)
        expect(result.attachments).toHaveLength(1)

        const attachment = result.attachments?.[0]
        expect(attachment).toBeDefined()
        expect(attachment?.mime).toBe("image/png")
        expect(attachment?.filename).toBe("image.png")
        expect(attachment?.localPath).toBe(filepath)
        expect(attachment?.url).toStartWith("data:image/png;base64,")
        expect(attachment?.model).toEqual({
          mode: "provider-file",
          summary: "image.png (image/png) loaded by view_image",
        })
        expect(attachment?.presentation).toEqual({ renderer: "image", size: "medium", crop: false })
      },
    })
  })

  test("rejects non-image files without attachments", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "note.txt"), "hello world")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const viewImage = await ViewImageTool.init()
        const result = await viewImage.execute({ filePath: path.join(tmp.path, "note.txt") }, ctx)

        expect(result.title).toBe("Unsupported file type")
        expect(result.output).toContain("is not an image")
        expect(result.output).toContain("Use read/scan_document")
        expect(result.metadata.error).toBe("unsupported_file_type")
        expect(result.attachments).toBeUndefined()
      },
    })
  })

  test("rejects files whose image extension does not match the content", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "fake.png"), "not an image")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const viewImage = await ViewImageTool.init()
        const result = await viewImage.execute({ filePath: path.join(tmp.path, "fake.png") }, ctx)

        expect(result.title).toBe("Unsupported file type")
        expect(result.output).toContain("content does not match image/png")
        expect(result.metadata.error).toBe("unsupported_file_type")
        expect(result.attachments).toBeUndefined()
      },
    })
  })

  test("missing file returns file_not_found metadata without attachments", async () => {
    await using tmp = await tmpdir()

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const viewImage = await ViewImageTool.init()
        const missingPath = path.join(tmp.path, "missing.png")
        const result = await viewImage.execute({ filePath: missingPath }, ctx)

        expect(result.title).toBe("File not found")
        expect(result.output).toBe(`Error: File not found: ${missingPath}`)
        expect(result.metadata.error).toBe("file_not_found")
        expect(result.attachments).toBeUndefined()
      },
    })
  })

  test("asks for read permission with the resolved absolute path", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "relative.png"), PNG_BYTES)
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const viewImage = await ViewImageTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }

        await viewImage.execute({ filePath: "relative.png" }, testCtx)

        expect(requests).toHaveLength(1)
        expect(requests[0]).toEqual({
          permission: "read",
          patterns: [path.join(tmp.path, "relative.png")],
          metadata: {},
        })
      },
    })
  })
})
