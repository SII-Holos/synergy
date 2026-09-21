import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionDrive } from "../../src/session/drive"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionManager } from "../../src/session/manager"

/** Queue work that the drive gate would otherwise treat as a reason to wake. */
function enqueueTask(sessionID: string) {
  return SessionInbox.enqueueUser({
    sessionID,
    model: { providerID: "test", modelID: "test" },
    parts: [{ type: "text", text: "queued request" }],
  })
}

/** Force a latch past the writer, to model a session that somehow carries one. */
async function forceLatch(sessionID: string, mode: "interactive" | "unattended") {
  await Session.update(sessionID, (draft) => {
    draft.paused = { reason: "aborted", since: Date.now() }
    draft.interaction = mode === "unattended" ? SessionInteraction.unattended("test") : undefined
  })
}

describe("SessionDrive pause gate", () => {
  test("refuses a paused session even though it has runnable work", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Paused with work" })
        await enqueueTask(session.id)
        // The queued item is what makes this case discriminating: if the pause
        // check ran *after* discovery, the request would report handled and the
        // session would wake, defeating the pause the user asked for.
        expect(await SessionInbox.hasRunnableItem(session.id)).toBe(true)
        expect(await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })).toBe(true)

        try {
          expect(await SessionDrive.request(session.id, "test-gate")).toBe(false)
          expect(SessionManager.isRunning(session.id)).toBe(false)
        } finally {
          SessionDrive.reset()
        }
      },
    })
  })

  test("force does not bypass the pause gate", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Forced while paused" })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })

        try {
          // `force` exists so an explicit Continue can resume work discovery
          // cannot see. It must not become a way to drive a stopped session, so
          // the same gate applies.
          expect(await SessionDrive.request(session.id, "test-force", { force: true })).toBe(false)
          expect(SessionManager.isRunning(session.id)).toBe(false)
        } finally {
          SessionDrive.reset()
        }
      },
    })
  })

  test("a latch on a machine session does not gate it", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const machine = await Session.create({ title: "Machine with latch" })
        await enqueueTask(machine.id)
        await forceLatch(machine.id, "unattended")

        try {
          // Same latch, same queued work as the interactive case above. Machine
          // sessions keep their automatic driving, so only the interaction mode
          // can explain the difference in outcome.
          expect(await SessionDrive.request(machine.id, "test-machine", { force: true })).toBe(true)
        } finally {
          SessionDrive.reset()
        }
      },
    })
  })
})
