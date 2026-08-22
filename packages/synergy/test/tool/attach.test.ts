import { describe, expect, test } from "bun:test"
import path from "path"
import { AttachTool } from "../../src/tool/attach"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "ses_attach_test",
  messageID: "msg_attach_test",
  callID: "call_attach_test",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.attach", () => {
  test("records the normalized source path and size on delivered attachments", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "artifact.md"), "# Artifact")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AttachTool.init()
        const sourcePath = path.join(tmp.path, "artifact.md")
        const result = await tool.execute({ file_path: "artifact.md" }, ctx)
        expect(result.attachments?.[0]).toMatchObject({
          localPath: sourcePath,
          metadata: {
            kind: "attachment",
            attachment: {
              originTool: "attach",
              sourcePath,
              size: 10,
              deliverable: true,
            },
          },
        })
        // The tool card is hidden so attachments render as an auto-expanded
        // gallery in the session timeline instead of a collapsed card.
        expect(result.metadata).toMatchObject({
          display: { toolCard: "hidden" },
        })
      },
    })
  })

  test("emits hidden tool card display metadata for delivered files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.png"), "aaa")
        await Bun.write(path.join(dir, "b.pdf"), "bbbb")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AttachTool.init()
        const result = await tool.execute({ file_path: ["a.png", "b.pdf"] }, ctx)
        expect(result.metadata).toMatchObject({
          display: { toolCard: "hidden" },
        })
        expect(result.attachments).toHaveLength(2)
        expect(result.title).toBe("2 files")
      },
    })
  })
})
