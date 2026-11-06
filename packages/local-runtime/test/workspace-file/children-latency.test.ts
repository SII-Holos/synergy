import { afterAll, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceFileService } from "../../src/workspace-file/service"
import { WorkspaceFileStatus } from "../../src/workspace-file/status"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("file entries and content display while Git status is unavailable", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "visible without Git")
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        using status = spyOn(WorkspaceFileStatus, "statusMap").mockRejectedValue(
          new Error("status is still calculating"),
        )
        using parent = spyOn(WorkspaceFileStatus, "statusForPath").mockRejectedValue(
          new Error("status is still calculating"),
        )
        const children = await WorkspaceFileService.children({})
        expect(children.children.map((entry) => entry.name)).toContain("file.txt")
        const read = await WorkspaceFileService.read({ path: "file.txt" })
        expect(read.kind).toBe("text")
        if (read.kind === "text") expect(read.content).toBe("visible without Git")
        expect((await WorkspaceFileService.node("file.txt")).name).toBe("file.txt")
        expect(status).not.toHaveBeenCalled()
        expect(parent).not.toHaveBeenCalled()
      },
    })
  }))
