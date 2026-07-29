import { describe, expect, spyOn, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEvent } from "../../src/session/event"
import { SessionNav } from "../../src/session/nav"
import { SessionMutation } from "../../src/session/mutation"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

function sameKey(left: string[], right: string[]) {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function pauseFirstSessionInfoUpdate(infoPath: string[]) {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const originalUpdate = Storage.update
  let updates = 0
  const spy = spyOn(Storage, "update").mockImplementation((async <T>(
    key: string[],
    editor: (draft: T) => void,
    options?: Storage.WriteOptions,
  ) => {
    const result = await originalUpdate(key, editor, options)
    if (sameKey(key, infoPath) && ++updates === 1) {
      reached.resolve()
      await release.promise
    }
    return result
  }) as typeof Storage.update)
  return {
    reached: reached.promise,
    release: () => release.resolve(),
    updates: () => updates,
    spy,
  }
}

function pauseFirstIndexWrite(indexPath: string[]) {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const originalWrite = Storage.write
  let writes = 0
  const spy = spyOn(Storage, "write").mockImplementation(async (key, content, options) => {
    if (sameKey(key, indexPath) && ++writes === 1) {
      reached.resolve()
      await release.promise
    }
    return originalWrite(key, content, options)
  })
  return {
    reached: reached.promise,
    release: () => release.resolve(),
    writes: () => writes,
    spy,
  }
}

describe("session mutation serialization", () => {
  test("preserves a concurrent title update while recording activity", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Original" })
        const pause = pauseFirstSessionInfoUpdate(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(session.id)),
        )
        using _update = pause.spy
        let titleEditorRan = false

        try {
          const activity = Session.recordActivity(session.id)
          await pause.reached
          const title = Session.update(session.id, (draft) => {
            titleEditorRan = true
            draft.title = "Concurrent title"
          })
          await Bun.sleep(25)

          expect(titleEditorRan).toBe(false)
          pause.release()
          await Promise.all([activity, title])
          expect((await Session.get(session.id)).title).toBe("Concurrent title")
        } finally {
          pause.release()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("preserves both fields from concurrent updates on one session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Original" })
        const pause = pauseFirstSessionInfoUpdate(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(session.id)),
        )
        using _update = pause.spy
        let pinnedEditorRan = false

        try {
          const title = Session.update(session.id, (draft) => {
            draft.title = "Serialized title"
          })
          await pause.reached
          const pinned = Session.update(session.id, (draft) => {
            pinnedEditorRan = true
            draft.pinned = 42
          })
          await Bun.sleep(25)

          expect(pinnedEditorRan).toBe(false)
          pause.release()
          await Promise.all([title, pinned])
          expect(await Session.get(session.id)).toMatchObject({ title: "Serialized title", pinned: 42 })
        } finally {
          pause.release()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("serializes last exchange writes with session projections", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Original" })
        const pause = pauseFirstSessionInfoUpdate(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(session.id)),
        )
        using _update = pause.spy

        try {
          const title = Session.update(session.id, (draft) => {
            draft.title = "Updated title"
          })
          await pause.reached
          const exchange = Session.updateLastExchange(session.id)
          await Bun.sleep(25)

          expect(pause.updates()).toBe(1)
          pause.release()
          await Promise.all([title, exchange])
          expect(await Session.get(session.id)).toMatchObject({ title: "Updated title", lastExchange: {} })
        } finally {
          pause.release()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("serializes removal with an active session projection", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Remove after update" })
        const pause = pauseFirstSessionInfoUpdate(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(session.id)),
        )
        using _update = pause.spy
        let removalFinished = false
        let removal: Promise<unknown> | undefined

        try {
          const update = Session.update(session.id, (draft) => {
            draft.pinned = 7
          })
          await pause.reached
          removal = Session.remove(session.id).then(() => {
            removalFinished = true
          })
          await Bun.sleep(25)

          expect(removalFinished).toBe(false)
          pause.release()
          await Promise.all([update, removal])
          await expect(Session.get(session.id)).rejects.toThrow()
        } finally {
          pause.release()
          await removal?.catch(() => undefined)
          if (!removalFinished) await Session.remove(session.id)
        }
      },
    })
  })

  test("serializes page index projections across different sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const first = await Session.create({ title: "First" })
        const second = await Session.create({ title: "Second" })
        const pause = pauseFirstIndexWrite(StoragePath.sessionsPageIndex(Identifier.asScopeID(scope.id)))
        using _write = pause.spy

        try {
          const firstUpdate = Session.update(first.id, (draft) => {
            draft.pinned = 11
          })
          await pause.reached
          const secondUpdate = Session.update(second.id, (draft) => {
            draft.pinned = 22
          })
          await Bun.sleep(25)

          expect(pause.writes()).toBe(1)
          pause.release()
          await Promise.all([firstUpdate, secondUpdate])
          const entries = await Session.readPageIndex(scope.id)
          expect(entries.entries.find((entry) => entry.id === first.id)?.pinned).toBe(11)
          expect(entries.entries.find((entry) => entry.id === second.id)?.pinned).toBe(22)
        } finally {
          pause.release()
          await Session.remove(second.id)
          await Session.remove(first.id)
        }
      },
    })
  })

  test("serializes recent navigation projections across different sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const first = await Session.create({ title: "First" })
        const second = await Session.create({ title: "Second" })
        const pause = pauseFirstIndexWrite(StoragePath.sessionNavIndex(Identifier.asScopeID(scope.id)))
        using _write = pause.spy

        try {
          const firstUpdate = Session.update(first.id, (draft) => {
            draft.title = "First updated"
          })
          await pause.reached
          const secondUpdate = Session.update(second.id, (draft) => {
            draft.title = "Second updated"
          })
          await Bun.sleep(25)

          expect(pause.writes()).toBe(1)
          pause.release()
          await Promise.all([firstUpdate, secondUpdate])
          const entries = (await SessionNav.queryScope(scope.id, { limit: 10 })).items
          expect(entries.find((entry) => entry.id === first.id)?.title).toBe("First updated")
          expect(entries.find((entry) => entry.id === second.id)?.title).toBe("Second updated")
        } finally {
          pause.release()
          await Session.remove(second.id)
          await Session.remove(first.id)
        }
      },
    })
  })

  test("serializes child index projections across sibling sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({ title: "Parent" })
        const first = await Session.create({ title: "First child", parentID: parent.id })
        const second = await Session.create({ title: "Second child", parentID: parent.id })
        const pause = pauseFirstIndexWrite(
          StoragePath.sessionChildIndex(Identifier.asScopeID(scope.id), Identifier.asSessionID(parent.id)),
        )
        using _write = pause.spy

        try {
          const firstUpdate = Session.update(first.id, (draft) => {
            draft.title = "First updated"
          })
          await pause.reached
          const secondUpdate = Session.update(second.id, (draft) => {
            draft.title = "Second updated"
          })
          await Bun.sleep(25)

          expect(pause.writes()).toBe(1)
          pause.release()
          await Promise.all([firstUpdate, secondUpdate])
          const entries = await Session.readChildIndex(scope.id, parent.id)
          expect(entries.entries.find((entry) => entry.id === first.id)?.title).toBe("First updated")
          expect(entries.entries.find((entry) => entry.id === second.id)?.title).toBe("Second updated")
        } finally {
          pause.release()
          await Session.remove(second.id)
          await Session.remove(first.id)
          await Session.remove(parent.id)
        }
      },
    })
  })

  test("awaits deleted subscribers after releasing the session mutation lock", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Remove with subscriber" })
        const subscriberStarted = Promise.withResolvers<void>()
        const releaseSubscriber = Promise.withResolvers<void>()
        let removalFinished = false
        const unsubscribe = Bus.subscribe(SessionEvent.Deleted, async (event) => {
          if (event.properties.info.id !== session.id) return
          using _mutation = await SessionMutation.write(scope.id, session.id)
          subscriberStarted.resolve()
          await releaseSubscriber.promise
        })

        try {
          const removal = Session.remove(session.id).then(() => {
            removalFinished = true
          })
          await Promise.race([
            subscriberStarted.promise,
            Bun.sleep(1000).then(() => {
              throw new Error("Deleted subscriber did not acquire the released session mutation lock")
            }),
          ])
          await Bun.sleep(25)

          expect(removalFinished).toBe(false)
          releaseSubscriber.resolve()
          await removal
          expect(removalFinished).toBe(true)
        } finally {
          releaseSubscriber.resolve()
          unsubscribe()
        }
      },
    })
  })

  test("allows an update subscriber to mutate the same session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Outer" })
        const nested = Promise.withResolvers<void>()
        let triggered = false
        const unsubscribe = Bus.subscribe(SessionEvent.Updated, (event) => {
          if (event.properties.info.id !== session.id || triggered) return
          triggered = true
          void Session.update(session.id, (draft) => {
            draft.pinned = 99
          }).then(
            () => nested.resolve(),
            (error) => nested.reject(error),
          )
        })

        try {
          await Session.update(session.id, (draft) => {
            draft.title = "Outer updated"
          })
          await Promise.race([
            nested.promise,
            Bun.sleep(1000).then(() => {
              throw new Error("Nested session update timed out")
            }),
          ])
          expect(await Session.get(session.id)).toMatchObject({ title: "Outer updated", pinned: 99 })
        } finally {
          unsubscribe()
          await Session.remove(session.id)
        }
      },
    })
  })
})
