import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { Identifier } from "../../src/id/id"
import { LatticeStore } from "../../src/lattice/store"
import { NoteStore } from "../../src/note"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRecovery } from "../../src/session/recovery"
import * as SessionWorking from "../../src/session/working"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function assertExists<T>(value: T | undefined): asserts value is T {
  if (value === undefined) throw new Error("expected defined value")
}

async function createPendingUserMessage(sessionID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
}

async function createIncompleteAssistant(sessionID: string) {
  const user = await createPendingUserMessage(sessionID)
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: user.id,
    time: { created: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: process.cwd(), root: process.cwd() },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

async function createBlueprintNote() {
  return NoteStore.create({
    title: "Restart-safe Blueprint",
    kind: "blueprint",
    blueprint: {
      description: "Recover loop references after restart.",
    },
  })
}

describe("SessionRecovery.reconcileRuntimeState", () => {
  test("clears stale pendingReply and preserves a genuine pending reply", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const stale = await Session.create({})
        await Session.update(stale.id, (draft) => {
          draft.pendingReply = true
        })

        const pending = await Session.create({})
        await createPendingUserMessage(pending.id)
        await Session.update(pending.id, (draft) => {
          draft.pendingReply = true
        })

        const report = await SessionRecovery.reconcileRuntimeState({
          scopeID: ScopeContext.current.scope.id,
          apply: true,
        })

        expect(report.changed).toBeGreaterThanOrEqual(1)
        expect((await Session.get(stale.id)).pendingReply).toBeUndefined()
        expect((await Session.get(pending.id)).pendingReply).toBe(true)
      },
    })
  })

  test("keeps incomplete assistant turns as recovering without abort repair", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const assistant = await createIncompleteAssistant(session.id)
        await Session.update(session.id, (draft) => {
          draft.pendingReply = true
        })

        await SessionRecovery.reconcileRuntimeState({
          scopeID: ScopeContext.current.scope.id,
          apply: true,
        })

        const refreshed = await Session.get(session.id)
        expect(refreshed.pendingReply).toBe(true)

        const messages = await Session.messages({ sessionID: session.id, raw: true })
        const assistantMessage = messages.find((message) => message.info.id === assistant.id)
        assertExists(assistantMessage)
        expect((assistantMessage.info as MessageV2.Assistant).time.completed).toBeUndefined()

        const statuses = await SessionManager.listStatuses(ScopeContext.current.scope.id)
        expect(statuses[session.id]).toEqual({ type: "recovering" })
      },
    })
  })

  test("restores active BlueprintLoop note and execution session bindings", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
        await NoteStore.update(ScopeContext.current.scope.id, note.id, {
          blueprint: { activeLoopID: null },
        })

        await SessionRecovery.reconcileRuntimeState({
          scopeID: ScopeContext.current.scope.id,
          apply: true,
        })

        const refreshedSession = await Session.get(session.id)
        const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
        expect(refreshedSession.blueprint).toEqual({ loopID: loop.id, loopRole: "execution" })
        expect(refreshedNote.blueprint?.activeLoopID).toBe(loop.id)

        const statuses = await SessionManager.listStatuses(ScopeContext.current.scope.id)
        expect(statuses[session.id]).toEqual({ type: "recovering" })
      },
    })
  })

  test("clears dangling terminal BlueprintLoop note and session references", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "completed" })
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })
        await NoteStore.update(ScopeContext.current.scope.id, note.id, {
          blueprint: { activeLoopID: loop.id },
        })

        await SessionRecovery.reconcileRuntimeState({
          scopeID: ScopeContext.current.scope.id,
          apply: true,
        })

        const refreshedSession = await Session.get(session.id)
        const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
        expect(refreshedSession.blueprint?.loopID).toBeUndefined()
        expect(refreshedSession.blueprint?.loopRole).toBeUndefined()
        expect(refreshedNote.blueprint?.activeLoopID).toBeUndefined()
      },
    })
  })

  test("projects active Lattice workflow sessions as recovering without kicking continuation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const run = await LatticeStore.reset({ sessionID: session.id, mode: "auto", goal: "Recover only" })
        await Session.update(session.id, (draft) => {
          draft.workflow = {
            kind: "lattice",
            runID: run.id,
            mode: run.mode,
            firstBlueprintStarted: run.firstBlueprintStarted,
          }
        })

        const status = await SessionWorking.resolve(session.id)
        expect(status).toEqual({ status: "recovering" })
        const runtime = SessionManager.getRuntime(session.id)
        expect(runtime?.abort).toBeUndefined()
        expect(runtime?.status).toEqual({ type: "idle" })
      },
    })
  })
})
