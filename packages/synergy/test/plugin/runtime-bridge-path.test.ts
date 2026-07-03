import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { executeBridgeMethod } from "../../src/plugin-runtime/bridge-handlers"
import { tmpdir } from "../fixture/fixture"

function bridgeParams(directory: string, params: Record<string, unknown>) {
  return {
    ...params,
    context: {
      sessionID: "ses_bridge_path_test",
      messageID: "msg_bridge_path_test",
      agent: "synergy",
      directory,
    },
  }
}

describe("plugin runtime bridge workspace path containment", () => {
  test("rejects absolute paths outside the workspace before permission checks", async () => {
    await using tmp = await tmpdir()
    const outside = path.join(path.dirname(tmp.path), "outside.txt")

    await expect(
      executeBridgeMethod({
        pluginId: "bridge-test",
        pluginDir: tmp.path,
        method: "file.read" as any,
        params: bridgeParams(tmp.path, { path: outside }),
      }),
    ).rejects.toThrow("escapes workspace directory")
  })

  test("rejects symlink directory writes that escape the workspace", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.mkdir(path.join(dir, "outside"), { recursive: true })
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const outside = path.join(tmp.path, "outside")
    const link = path.join(workspace, "linked-out")

    try {
      await fs.symlink(outside, link, "dir")
    } catch {
      return
    }

    await expect(
      executeBridgeMethod({
        pluginId: "bridge-test",
        pluginDir: workspace,
        method: "file.write" as any,
        params: bridgeParams(workspace, { path: "linked-out/new.txt", data: "nope" }),
      }),
    ).rejects.toThrow("escapes workspace directory")
  })
})
