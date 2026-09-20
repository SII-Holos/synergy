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
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import * as SessionWorking from "@ericsanchezok/synergy-harness/session/working"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import "@ericsanchezok/synergy-product-runtime/product-registration"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

Log.init({ print: false })

const projectRoot = new URL("../..", import.meta.url).pathname

/**
 * The production incident, end to end: a runtime died mid-turn while a
 * BlueprintLoop was running, then restarted. Before the fixes this left the
 * session in a state no control could clear, with the in-flight bash call stuck
 * `running`. The honest replacement is a persisted pause: the session names the
 * workflow holding it, keeps the loop and the turn intact, and waits for the
 * user to continue or abandon.
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
  // No retired session flag: the crash is represented purely by what the
  // process left on disk — an unfinished turn and an unsettled tool call.

  return { session, note, loop, assistant, toolPartID }
}

/** Startup reconciliation, in the order ScopeStartup runs it.
 *
 *  It repairs durable workflow references and records the pause, but it never
 *  resumes the interrupted turn: a restart is evidence the turn was
 *  interrupted, not evidence the user wants it continued. */
async function restartRecovery() {
  await SessionRecovery.reconcileRuntimeState({ scopeID: ScopeContext.current.scope.id, apply: true })
  await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)
}

async function readToolPart(sessionID: string, messageID: string, partID: string) {
  const parts = await MessageV2.parts({ sessionID, messageID })
  const part = parts.find((candidate) => candidate.id === partID)
  if (part?.type !== "tool") throw new Error("expected tool part")
  return part
}

describe("crashed-runtime recovery end to end", () => {
  test("restores an honest, actionable session instead of a permanent paused state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, note, loop, assistant, toolPartID } = await reproduceCrashedTurn()

        // Precondition: nothing has reconciled yet. The crash is visible only as
        // what the dead process left on disk, and a stored loop is a record of
        // intent rather than evidence of work, so no status pinning the session
        // can be derived from it.
        expect(await SessionWorking.resolve(session.id)).toBeUndefined()
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")

        await restartRecovery()

        // 1. The session is stopped and says why. The pause is the honest,
        // durable state, and the workflow holding it is named so the user has
        // something to act on instead of an unexplained stall.
        const paused = await SessionLifecycle.snapshot(session.id)
        expect(paused?.reason).toBe("workflow")
        expect(paused?.description).toBe("Stopped by BlueprintLoop; continue or abandon")
        const status = (await SessionManager.listStatuses(ScopeContext.current.scope.id))[session.id]
        expect(status).toMatchObject({
          type: "paused",
          reason: "workflow",
          description: "Stopped by BlueprintLoop; continue or abandon",
        })
        expect(await SessionWorking.resolve(session.id)).toMatchObject({ status: "paused", reason: "workflow" })

        // 2. The orphaned loop is preserved rather than terminalized. A restart
        // is evidence the turn stopped, not that the user's work should fail,
        // and this record is the only handle left for continuing or abandoning it.
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")

        // 3. Its references stay bound, because the loop they point at is live:
        // clearing them here would destroy the user's ability to continue.
        expect((await Session.get(session.id)).blueprint).toEqual({ loopID: loop.id, loopRole: "execution" })
        expect((await NoteStore.get(ScopeContext.current.scope.id, note.id)).blueprint?.activeLoopID).toBe(loop.id)

        // 4. The interrupted turn stays resumable. The in-flight tool call is
        // deliberately not settled here and the assistant is not terminalized,
        // so a continue has real work to resume instead of being a silent no-op.
        const parts = await MessageV2.parts({ sessionID: session.id, messageID: assistant.id })
        const toolPart = parts.find((part) => part.id === toolPartID)
        if (toolPart?.type !== "tool") throw new Error("expected tool part")
        expect(toolPart.state.status).toBe("running")
        const messages = await Session.messages({ sessionID: session.id })
        const interrupted = messages.find((message) => message.info.id === assistant.id)
        if (interrupted?.info.role !== "assistant") throw new Error("expected assistant message")
        expect(SessionProgress.isTerminalAssistant(interrupted.info)).toBe(false)
      },
    })
  })

  test("the abandon control actually unblocks a stuck session and stops reporting a false success", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // The state the user was actually staring at: the assistant turn had
        // already ended in error, but the bash call was still `running` and the
        // loop still claimed to be active.
        const { session, loop, assistant, toolPartID } = await reproduceCrashedTurn({ assistantFinish: "error" })

        const result = await SessionAbort.abort(session.id, { abandonWorkflow: true, terminalize: true })

        // The visible control has a real effect instead of returning success
        // while changing nothing.
        expect(SessionAbort.hadEffect(result)).toBe(true)
        expect(result.repaired).toBe(true)
        expect(result.abandoned).toBe(true)
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("cancelled")

        const toolPart = await readToolPart(session.id, assistant.id, toolPartID)
        expect(toolPart.state.status).toBe("error")

        // Abandoning is the terminal exit, so the session must not stay paused
        // waiting for a continue the user has already declined.
        await SessionLifecycle.clear(session.id)
        expect(await SessionWorking.resolve(session.id)).toBeUndefined()
      },
    })
  })

  test("reports no further effect once the interrupted turn is already settled", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await reproduceCrashedTurn()
        await restartRecovery()

        // Startup recovery records the pause but deliberately leaves the
        // interrupted turn alone, so the first explicit repair is real work.
        const first = await SessionInvoke.repairAbortState(session.id)
        expect(first.repaired).toBe(true)
        expect(first.paused).toBe(false)

        // A repeat must report that it changed nothing rather than claiming a
        // second success on an already-settled turn, and it must not rewrite the
        // latch, whose original cause is the thing worth keeping.
        const second = await SessionInvoke.repairAbortState(session.id)
        expect(second.repaired).toBe(false)
        expect(second.abandoned).toBe(false)
        expect(second.paused).toBe(false)
        expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("workflow")
      },
    })
  })

  test("keeps a healthy running loop untouched through restart recovery", async () => {
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
  })
})
