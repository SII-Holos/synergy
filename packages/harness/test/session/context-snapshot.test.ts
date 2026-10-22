import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionContextSnapshot } from "../../src/session/context-snapshot"
import { MessageV2 } from "../../src/session/message-v2"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { SessionEvent } from "../../src/session/event"
import { Bus } from "../../src/bus"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("completed context is immutable and revision checks detect edits, append, deletion and rollback without bodies", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          isRoot: true,
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
        })
        const part = await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: root.id,
          type: "text",
          text: "修改这个方案",
        })
        await expect(SessionContextSnapshot.capture({ sessionID: session.id })).rejects.toThrow("completed")
        const assistant = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: root.id,
          rootID: root.id,
          time: { created: 2, completed: 3 },
          modelID: "test",
          providerID: "test",
          mode: "synergy",
          agent: "synergy",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })
        const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
        await RolloutLedger.beginRun(owner, root.id)
        await expect(SessionContextSnapshot.capture({ sessionID: session.id })).rejects.toThrow("completed")
        const completions: unknown[] = []
        const unsubscribe = Bus.subscribe(SessionEvent.RootCompleted, (event) => completions.push(event.properties))
        await RolloutLifecycle.reconcile(session.id, root.id)
        await RolloutLifecycle.reconcile(session.id, root.id)
        unsubscribe()
        expect(completions).toEqual([{ sessionID: session.id, rootID: root.id, assistantID: assistant.id }])
        const captured = await SessionContextSnapshot.capture({
          sessionID: session.id,
          expected: { rootID: root.id, assistantID: assistant.id },
        })
        expect(captured.stamp.rootID).toBe(root.id)
        expect(captured.model).toEqual({ providerID: "test", modelID: "test" })
        expect(Object.isFrozen(captured.messages[0]!.parts)).toBe(true)
        const hydrate = spyOn(MessageV2, "parts")
        expect(await SessionContextSnapshot.isCurrent(captured.stamp)).toBe(true)
        expect(hydrate).not.toHaveBeenCalled()
        hydrate.mockRestore()
        await Session.updatePart({
          id: part.id,
          sessionID: session.id,
          messageID: root.id,
          type: "text",
          text: "换个方案",
        })
        expect(await SessionContextSnapshot.isCurrent(captured.stamp)).toBe(false)
        expect(captured.messages[0]!.parts[0]).toMatchObject({ text: "修改这个方案" })
        const edited = await SessionContextSnapshot.capture({ sessionID: session.id })
        await Session.removePart({ sessionID: session.id, messageID: root.id, partID: part.id })
        expect(await SessionContextSnapshot.isCurrent(edited.stamp)).toBe(false)
        const deleted = await SessionContextSnapshot.capture({ sessionID: session.id })
        await Session.updateMessage({ ...root, id: Identifier.ascending("message"), time: { created: 4 } })
        expect(await SessionContextSnapshot.isCurrent(deleted.stamp)).toBe(false)
        await expect(SessionContextSnapshot.capture({ sessionID: session.id })).rejects.toThrow("completed")
        await Session.remove(session.id)
      },
    })
  }))

test("metadata batches preserve missing positions, duplicates and transaction revisions", () =>
  runtime.run(async () => {
    const keys = Array.from({ length: 140 }, (_, index) => ["snapshot-test", String(index)])
    await Storage.transaction(async (tx) => {
      await tx.writeMany(keys.map((key) => ({ key, value: { body: "do not hydrate" } })))
      const revisions = await tx.revisions([...keys, keys[0]!, ["snapshot-test", "missing"]])
      expect(revisions.slice(0, 140).every((value) => value !== undefined)).toBe(true)
      expect(revisions[140]).toBe(revisions[0])
      expect(revisions[141]).toBeUndefined()
      await tx.remove(keys[0]!)
      expect((await tx.revisions([keys[0]!]))[0]).toBeUndefined()
    })
    await Storage.removeTree(["snapshot-test"])
  }))
