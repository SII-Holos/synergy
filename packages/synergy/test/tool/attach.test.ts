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
            },
          },
        })
      },
    })
  })
})
