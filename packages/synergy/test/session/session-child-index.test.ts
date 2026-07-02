import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("session child index", () => {
  test("tracks create, update, parent move, archive, and removal", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parentA = await Session.create({ title: "Parent A" })
        const parentB = await Session.create({ title: "Parent B" })
        const child = await Session.create({ title: "Child", parentID: parentA.id })
        const sibling = await Session.create({ title: "Sibling", parentID: parentA.id })

        let indexA = await Session.readChildIndex(scope.id, parentA.id)
        expect(indexA.entries.map((entry) => entry.id)).toContain(child.id)
        expect(indexA.entries.map((entry) => entry.id)).toContain(sibling.id)

        await Session.update(child.id, (draft) => {
          draft.title = "Renamed child"
        })
        indexA = await Session.readChildIndex(scope.id, parentA.id)
        expect(indexA.entries.find((entry) => entry.id === child.id)?.title).toBe("Renamed child")

        await Session.update(child.id, (draft) => {
          draft.parentID = parentB.id
        })
        indexA = await Session.readChildIndex(scope.id, parentA.id)
        const indexB = await Session.readChildIndex(scope.id, parentB.id)
        expect(indexA.entries.map((entry) => entry.id)).not.toContain(child.id)
        expect(indexB.entries.map((entry) => entry.id)).toContain(child.id)

        await Session.update(child.id, (draft) => {
          draft.time.archived = Date.now()
        })
        const archivedIndex = await Session.readChildIndex(scope.id, parentB.id)
        expect(archivedIndex.entries.find((entry) => entry.id === child.id)?.archived).toBe(true)

        const children = await Session.children(parentB.id)
        expect(children.map((session) => session.id)).toContain(child.id)

        await Session.remove(child.id)
        const afterChildRemove = await Session.readChildIndex(scope.id, parentB.id)
        expect(afterChildRemove.entries.map((entry) => entry.id)).not.toContain(child.id)

        await Session.remove(parentA.id)
        await Session.remove(parentB.id)
      },
    })
  })
})
