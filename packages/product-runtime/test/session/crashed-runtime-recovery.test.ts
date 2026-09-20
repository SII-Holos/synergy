import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-workflows/blueprint/loop-store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import * as SessionWorking from "@ericsanchezok/synergy-harness/session/working"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

const projectRoot = new URL("../..", import.meta.url).pathname

/**
 * The production incident, end to end: a runtime died mid-turn while a
 * BlueprintLoop was running, then restarted. Before the fixes this left the
 * session permanently `recovering`, un-abortable, with the in-flight bash call
 * stuck `running`.
 */
async function reproduceCrashedTurn(input: { assistantFinish?: string } = {}) {
  const session = await Session.create({})
  const note = await NoteStore.create({
    title: "Restart recovery Blueprint",
    kind: "blueprint",
    blueprint: { description: "Survive a runtime that died mid-turn." },
  })

  const loop = await BlueprintLoopStore.create({
    noteID: note.id,
    noteVersion: note.version,
    title: note.title,
    sessionID: session.id,
    runMode: "current",
  })
  await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
  await Session.update(session.id, (draft) => {
    draft.blueprint = { loopID: loop.id, loopRole: "execution" }
  })
  await NoteStore.update(ScopeContext.current.scope.id, note.id, {
    blueprint: { activeLoopID: loop.id },
  })

  // The real root user turn. It must carry a non-system part: root semantics
  // are derived from the parts, and a partless user message is not a
  // reply-required root.
  const rootID = Identifier.ascending("message")
  const root = await Session.updateMessage({
    id: rootID,
    sessionID: session.id,
    role: "user",
    rootID,
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() - 2000 },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: root.id,
    type: "text",
    text: "你直接在这个 worktree 里实现吧",
  })

  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "assistant",
    parentID: root.id,
    rootID: root.id,
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: projectRoot, root: projectRoot },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: input.assistantFinish
      ? { created: Date.now() - 1500, completed: Date.now() - 1000 }
      : { created: Date.now() - 1500 },
    finish: input.assistantFinish,
  })

  // The bash call the process died before settling.
  const toolPartID = Identifier.ascending("part")
  await Session.updatePart({
    id: toolPartID,
    sessionID: session.id,
    messageID: assistant.id,
    type: "tool",
    callID: "call_crashed_turn",
    tool: "bash",
    state: {
      status: "running",
      input: { command: 'grep -n "Vite" script/coverage-exempt.json' },
      time: { start: Date.now() - 1500 },
    },
  })
  await Session.update(session.id, (draft) => {
    draft.pendingReply = true
  })

  return { session, note, loop, assistant, toolPartID }
}

/** Startup recovery, in the order ScopeStartup runs it. */
async function restartRecovery() {
  await SessionRecovery.reconcileRuntimeState({ scopeID: ScopeContext.current.scope.id, apply: true })
  await SessionInvoke.resumePending({ scopeID: ScopeContext.current.scope.id })
}

async function readToolPart(sessionID: string, messageID: string, partID: string) {
  const parts = await MessageV2.parts({ sessionID, messageID })
  const part = parts.find((candidate) => candidate.id === partID)
  if (part?.type !== "tool") throw new Error("expected tool part")
  return part
}

describe("crashed-runtime recovery end to end", () => {
  test("restores an honest, actionable session instead of a permanent recovering state", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, note, loop, assistant, toolPartID } = await reproduceCrashedTurn()

          // Precondition: the crash left the session pinned by the phantom loop.
          const before = await SessionWorking.resolve(session.id)
          expect(before?.status).toBe("recovering")
          if (before?.status !== "recovering") throw new Error("expected recovering status")
          expect(before.reason).toBe("workflow")

          await restartRecovery()

          // 1. The orphaned loop is terminalized with a distinguishable cause.
          const recoveredLoop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
          expect(recoveredLoop.status).toBe("failed")
          expect(recoveredLoop.error).toStartWith("interrupted:")

          // 2. The interrupted turn and its in-flight tool call are no longer zombies.
          const parts = await MessageV2.parts({ sessionID: session.id, messageID: assistant.id })
          const toolPart = parts.find((part) => part.id === toolPartID)
          if (toolPart?.type !== "tool") throw new Error("expected tool part")
          expect(toolPart.state.status).toBe("error")
          if (toolPart.state.status !== "error") throw new Error("expected error state")
          expect(toolPart.state.error).toBe(MessageV2.INTERRUPTED_TOOL_ERROR)

          // 3. No dangling references remain, so the Blueprint is usable again.
          const refreshed = await Session.get(session.id)
          expect(refreshed.blueprint?.loopID).toBeUndefined()
          const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
          expect(refreshedNote.blueprint?.activeLoopID).toBeUndefined()

          // 4. The session reports idle, which is what makes the UI actionable.
          expect(await SessionManager.listStatuses(ScopeContext.current.scope.id)).toEqual({})
          expect(await SessionWorking.resolve(session.id)).toBeUndefined()

          // 5. The user can start a fresh run on the same Blueprint.
          const restarted = await BlueprintLoopStore.create({
            noteID: note.id,
            noteVersion: note.version,
            title: note.title,
            sessionID: session.id,
            runMode: "current",
          })
          expect(restarted.status).toBe("armed")
        },
      })
    }))

  test("the abort control actually unblocks a stuck session and stops reporting a false success", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          // The state the user was actually staring at: the automatic restart
          // repair had already terminalized the assistant message, but the bash
          // call was still `running` and the loop still claimed to be active.
          const { session, loop, assistant, toolPartID } = await reproduceCrashedTurn({ assistantFinish: "error" })

          const result = await SessionAbort.abort(session.id)

          // The visible control now has a real effect instead of returning success
          // while changing nothing.
          expect(SessionAbort.hadEffect(result)).toBe(true)
          expect(result.abandoned).toBe(true)
          expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("cancelled")

          const toolPart = await readToolPart(session.id, assistant.id, toolPartID)
          expect(toolPart.state.status).toBe("error")

          expect(await SessionWorking.resolve(session.id)).toBeUndefined()
        },
      })
    }))

  test("reports no effect when the session is already fully settled", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await reproduceCrashedTurn()
          await restartRecovery()

          // Everything was already repaired by startup recovery, so a later abort
          // must not claim it stopped work or republish idle.
          const result = await SessionInvoke.repairAbortState(session.id)
          expect(result.repaired).toBe(false)
          expect(result.abandoned).toBe(false)
          expect(result.settled).toBe(false)
        },
      })
    }))

  test("keeps a healthy running loop untouched through restart recovery", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, note, loop } = await reproduceCrashedTurn()
          // A queued inbox item is durable evidence that this loop still has a driver.
          await SessionInbox.enqueueMail({
            sessionID: session.id,
            mail: {
              type: "user",
              agent: "test",
              model: { providerID: "test-provider", modelID: "test-model" },
              parts: [
                {
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: Identifier.ascending("message"),
                  type: "text",
                  text: "continue the run",
                },
              ],
            },
          })

          await restartRecovery()

          expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
          const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
          expect(refreshedNote.blueprint?.activeLoopID).toBe(loop.id)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
