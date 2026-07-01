import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ScopeContext } from "../../src/scope/context"
import { WorkspaceFileStatus } from "../../src/workspace-file/status"
import { tmpdir } from "../fixture/fixture"

async function withWorkspace<T>(init: (dir: string) => Promise<void>, fn: (dir: string) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true, init })
  return ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      WorkspaceFileStatus.invalidate()
      try {
        return await fn(tmp.path)
      } finally {
        WorkspaceFileStatus.invalidate()
      }
    },
  })
}

describe("WorkspaceFileStatus", () => {
  test("does not read large untracked files for line counts", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "large-untracked.txt"), "x".repeat(300 * 1024))
      },
      async () => {
        const summary = await WorkspaceFileStatus.summary({ force: true })
        const file = summary.files.find((item) => item.path === "large-untracked.txt")
        expect(file).toMatchObject({ path: "large-untracked.txt", status: "untracked" })
        expect(file?.added).toBeUndefined()
        expect(file?.removed).toBeUndefined()
      },
    )
  })

  test("skips untracked line counts when the untracked set is too large", async () => {
    await withWorkspace(
      async (dir) => {
        await fs.mkdir(path.join(dir, "many"), { recursive: true })
        await Promise.all(
          Array.from({ length: 201 }, (_, index) =>
            Bun.write(path.join(dir, "many", `file-${index}.txt`), "one\ntwo\n"),
          ),
        )
      },
      async () => {
        const summary = await WorkspaceFileStatus.summary({ force: true })
        const file = summary.files.find((item) => item.path === "many/file-0.txt")
        expect(file).toMatchObject({ path: "many/file-0.txt", status: "untracked" })
        expect(file?.added).toBeUndefined()
        expect(file?.removed).toBeUndefined()
      },
    )
  })
})
