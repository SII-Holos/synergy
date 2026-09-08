import { expect, test } from "bun:test"
import path from "node:path"
import { EditTool } from "../../src/tools/edit"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"

test("local edit creates, authorizes, replaces and reports the actual file delta", async () => {
  await using directory = await tmpdir()
  await ScopeContext.provide({
    scope: await directory.scope(),
    async fn() {
      const approvals: string[] = []
      const context: Tool.Context = {
        sessionID: "edit-lifecycle",
        messageID: "message",
        callID: "call",
        agent: "synergy",
        abort: new AbortController().signal,
        metadata() {},
        async ask(input) {
          approvals.push(...input.patterns)
        },
      }
      const edit = await EditTool.init()
      const filePath = path.join(directory.path, "notes.txt")
      const created = await edit.execute({ filePath, oldString: "", newString: "first\nsecond\n" }, context)
      expect(await Bun.file(filePath).text()).toBe("first\nsecond\n")
      expect(created.metadata.filediff.additions).toBe(2)
      await FileTime.read(context.sessionID, filePath)
      const changed = await edit.execute({ filePath, oldString: "second", newString: "updated" }, context)
      expect(await Bun.file(filePath).text()).toBe("first\nupdated\n")
      expect(changed.metadata.filediff).toMatchObject({ additions: 1, deletions: 1 })
      expect(changed.metadata.diff).toContain("+updated")
      expect(approvals).toEqual(["notes.txt", "notes.txt"])
      await expect(edit.execute({ filePath, oldString: "same", newString: "same" }, context)).rejects.toThrow(
        "must be different",
      )
      await expect(
        edit.execute({ filePath: path.join(directory.path, "missing"), oldString: "old", newString: "new" }, context),
      ).rejects.toThrow("not found")
      await expect(
        edit.execute({ filePath: directory.path, oldString: "old", newString: "new" }, context),
      ).rejects.toThrow("directory")
    },
  })
})
