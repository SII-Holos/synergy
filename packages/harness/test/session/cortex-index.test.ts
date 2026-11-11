import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionCortexIndex as Index } from "../../src/session/cortex-index"
import { Storage } from "../../src/storage/storage"
import { Identifier } from "../../src/id/id"
import { MigrationRegistry } from "../../src/migration/registry"
import { SessionPreparingError } from "../../src/storage/errors"
import { Cortex } from "../../src/cortex/manager"
import { tmpdir } from "../support/fixture"

async function child(parent: Session.Info, visibility: "visible" | "hidden" = "visible") {
  return Session.create({
    workspace: null,
    parentID: parent.id,
    cortex: {
      taskID: Identifier.short("cortex"),
      parentSessionID: parent.id,
      parentMessageID: Identifier.ascending("message"),
      description: "Task ".repeat(180),
      prompt: "private task input".repeat(2000),
      status: "completed",
      agent: "general",
      startedAt: Date.now(),
      visibility,
      output: { mode: "summary", value: "private task output" },
    },
  })
}

test("native Cortex summary pages seek beyond one window without reading child payloads", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const other = await Session.create({ workspace: null })
        const expected: string[] = []
        for (let count = 0; count < 70; count++) expected.push((await child(parent)).id)
        const hidden = await child(parent, "hidden")
        await child(other)
        const pointReads: string[][] = []
        const original = Storage.readMany
        using reads = spyOn(Storage, "readMany")
        reads.mockImplementation((keys) => {
          pointReads.push(...keys)
          return original(keys)
        })
        let cursor: string | undefined
        const received: string[] = []
        do {
          const page = await Index.page(parent.scope.id, parent.id, { limit: 16, cursor })
          expect(page.items.length).toBeLessThanOrEqual(16)
          expect(page.total).toBe(70)
          const bytes = JSON.stringify(page)
          expect(bytes).not.toContain("private task")
          expect(bytes).not.toContain(hidden.id)
          received.push(...page.items.map((item) => item.sessionID))
          cursor = page.cursor
        } while (cursor)
        expect(received).toEqual(expected.sort())
        expect(pointReads.some((key) => key[0] === "sessions")).toBeFalse()
        const first = await Index.page(parent.scope.id, parent.id, { limit: 1 })
        await expect(Index.page(other.scope.id, other.id, { cursor: first.cursor })).rejects.toThrow()
        expect(first.items[0]?.description.length).toBeLessThanOrEqual(512)
        await Session.remove(first.items[0]!.sessionID)
        const after = await Index.page(parent.scope.id, parent.id, { limit: 1, cursor: first.cursor })
        expect(after.total).toBe(69)
        expect(after.items[0]?.sessionID).toBe(expected[1])
      },
    }),
  )
}, 15_000)

test("Cortex metadata follows the native writer transaction, visibility, parent move and deletion", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const other = await Session.create({ workspace: null })
        const task = await child(parent)
        const page = () => Index.page(parent.scope.id, parent.id, {})
        await expect(
          Storage.transaction(async () => {
            await Session.update(task.id, (draft) => { draft.cortex!.visibility = "hidden" })
            throw new Error("Rollback task mutation")
          }),
        ).rejects.toThrow("Rollback task mutation")
        expect((await page()).total).toBe(1)
        await Session.update(task.id, (draft) => { draft.cortex!.visibility = "hidden" })
        expect((await page()).total).toBe(0)
        await Session.update(task.id, (draft) => {
          draft.cortex!.visibility = "visible"
          draft.parentID = other.id
          draft.cortex!.parentSessionID = other.id
        })
        expect((await page()).total).toBe(0)
        expect((await Index.page(other.scope.id, other.id, {})).items[0]?.sessionID).toBe(task.id)
        await Session.remove(task.id)
        expect((await Index.page(other.scope.id, other.id, {})).total).toBe(0)
      },
    }),
  )
})

test("the registered owning upgrade builds retained task summaries without rewriting private metadata", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await child(parent)
        await Storage.removeTree(Index.key(parent.scope.id, parent.id))
        await expect(Index.page(parent.scope.id, parent.id, {})).rejects.toBeInstanceOf(SessionPreparingError)
        await Session.get(parent.id)
        expect(await Index.ready(parent.scope.id, parent.id)).toBeFalse()
        const migration = MigrationRegistry.list().get("session-cortex-index")?.[0]
        expect(migration?.upSession).toBeDefined()
        await Index.prepare(parent.scope.id, parent.id)
        expect((await Index.page(parent.scope.id, parent.id, {})).items[0]?.sessionID).toBe(task.id)
        const unchanged = await Session.get(task.id)
        expect(unchanged.cortex?.prompt).toBe(task.cortex?.prompt)
        expect(unchanged.cortex?.output).toEqual(task.cortex?.output)
        await migration!.upSession!({ scopeID: parent.scope.id, sessionID: parent.id }, () => {})
        expect((await Index.page(parent.scope.id, parent.id, {})).total).toBe(1)
        await Storage.write(Index.key(parent.scope.id, parent.id), {
          version: 2,
          scopeID: parent.scope.id,
          parentSessionID: parent.id,
          ready: true,
          total: 0,
        })
        await expect(Index.page(parent.scope.id, parent.id, {})).rejects.toThrow()
        await expect(migration!.upSession!({ scopeID: parent.scope.id, sessionID: parent.id }, () => {})).rejects.toThrow()
      },
    }),
  )
})

test("Cortex pages and qualified output survive a cold Runtime without exposing hidden tasks or choosing an imported duplicate", async () => {
  await using home = await tmpdir()
  const first = await testRuntime({ home: home.path })
  const stored = await first.run(() => ScopeContext.provide({
    scope: Scope.home(),
    workspace: null,
    fn: async () => {
      const parent = await Session.create({ workspace: null })
      const visible = await child(parent)
      await child(parent, "hidden")
      return { parentID: parent.id, childID: visible.id, taskID: visible.cortex!.taskID, prompt: visible.cortex!.prompt }
    },
  }))
  await first.close()
  await using second = await testRuntime({ home: home.path })
  await second.run(() => ScopeContext.provide({
    scope: Scope.home(),
    workspace: null,
    fn: async () => {
      const page = await Cortex.visibleSummaryPage(stored.parentID, { limit: 1 })
      expect(page.total).toBe(1)
      expect(page.items[0]).toMatchObject({ id: stored.taskID, sessionID: stored.childID })
      expect(JSON.stringify(page)).not.toContain("private task")
      const task = await Cortex.getVisibleTaskForOutput(stored.parentID, stored.taskID)
      expect(task?.prompt).toBe(stored.prompt)
      expect(task?.output).toEqual({ mode: "summary", value: "private task output" })
      const duplicate = await child(await Session.get(stored.parentID))
      await Session.update(duplicate.id, (draft) => { draft.cortex!.taskID = stored.taskID })
      expect(await Cortex.getVisibleTaskForOutput(stored.parentID, stored.taskID)).toBeUndefined()
      expect((await Cortex.getVisibleTaskForOutput(stored.parentID, stored.taskID, stored.childID))?.sessionID).toBe(stored.childID)
    },
  }))
}, 15_000)
