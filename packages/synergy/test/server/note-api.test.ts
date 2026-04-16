import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { NoteError, NoteStore } from "../../src/note"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("Note conflict payloads", () => {
  test("returns the current note in stale-version conflicts", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({
          title: "Test note",
          contentText: "first",
        })

        await NoteStore.update(scope.id, created.id, {
          contentText: "second",
          expectedVersion: created.version,
        })

        await expect(
          NoteStore.update(scope.id, created.id, {
            contentText: "third",
            expectedVersion: created.version,
          }),
        ).rejects.toMatchObject({
          name: "NoteConflictError",
          data: {
            expectedVersion: created.version,
            note: expect.objectContaining({
              id: created.id,
              version: created.version + 1,
            }),
          },
        })
      },
    })
  })
})
