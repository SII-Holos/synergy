import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../support/fixture"

const projectRoot = new URL("../..", import.meta.url).pathname

async function writeRoot(sessionID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
}

async function writeAssistant(sessionID: string, parentID: string, finish?: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    rootID: parentID,
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: projectRoot, root: projectRoot },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: finish ? { created: Date.now() - 1000, completed: Date.now() } : { created: Date.now() - 1000 },
    finish,
  })
}

/** A tool part left in the state a process that died mid-call would persist. */
async function writeRunningToolPart(input: { sessionID: string; messageID: string; callID: string }) {
  const id = Identifier.ascending("part")
  await Session.updatePart({
    id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: input.callID,
    tool: "bash",
    state: {
      status: "running",
      input: { command: "grep -n foo script/coverage-exempt.json" },
      time: { start: Date.now() - 500 },
    },
  })
  return id
}

async function readToolPart(sessionID: string, messageID: string, partID: string) {
  const parts = await MessageV2.parts({ sessionID, messageID })
  const part = parts.find((candidate) => candidate.id === partID)
  if (part?.type !== "tool") throw new Error("expected tool part")
  return part
}

async function findToolPart(sessionID: string, messageID: string, partID: string) {
  const parts = await MessageV2.parts({ sessionID, messageID })
  const part = parts.find((candidate) => candidate.id === partID)
  return part?.type === "tool" ? part : undefined
}

describe("orphaned tool part settlement on abort repair", () => {
  test("settles a running tool part left on an already-terminal assistant message", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeRoot(session.id)
        const assistant = await writeAssistant(session.id, root.id, "error")
        const partID = await writeRunningToolPart({
          sessionID: session.id,
          messageID: assistant.id,
          callID: "call_orphaned_1",
        })

        // The message is already terminal, which previously short-circuited the
        // repair and left the part `running` forever.
        await SessionInvoke.repairAfterAbort(session.id)

        const settled = await readToolPart(session.id, assistant.id, partID)
        expect(settled.state.status).toBe("error")
        if (settled.state.status !== "error") throw new Error("expected error state")
        expect(settled.state.error).toBe(MessageV2.INTERRUPTED_TOOL_ERROR)
        // The wording must not imply success or a replay.
        expect(settled.state.error).toContain("not replayed")
        expect(settled.state.error).toContain("unknown")
        expect(settled.state.time.end).toBeNumber()
      },
    })
  })

  test("settles tool parts on a non-terminal assistant message it terminalizes", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeRoot(session.id)
        const assistant = await writeAssistant(session.id, root.id)
        const first = await writeRunningToolPart({
          sessionID: session.id,
          messageID: assistant.id,
          callID: "call_orphaned_2a",
        })
        const second = await writeRunningToolPart({
          sessionID: session.id,
          messageID: assistant.id,
          callID: "call_orphaned_2b",
        })

        expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(true)

        expect((await readToolPart(session.id, assistant.id, first)).state.status).toBe("error")
        expect((await readToolPart(session.id, assistant.id, second)).state.status).toBe("error")
      },
    })
  })

  test("leaves a completed tool part untouched", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeRoot(session.id)
        const assistant = await writeAssistant(session.id, root.id, "error")
        const partID = Identifier.ascending("part")
        await Session.updatePart({
          id: partID,
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_completed",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "true" },
            output: "done",
            title: "true",
            metadata: {},
            time: { start: Date.now() - 500, end: Date.now() - 400 },
          },
        })

        await SessionInvoke.repairAfterAbort(session.id)

        expect((await readToolPart(session.id, assistant.id, partID)).state.status).toBe("completed")
      },
    })
  })

  test("settles an orphaned part on a superseded message, not only the newest turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        // Turn one: the process died mid-call and the repair was lost.
        const firstRoot = await writeRoot(session.id)
        const firstAssistant = await writeAssistant(session.id, firstRoot.id, "error")
        const orphaned = await writeRunningToolPart({
          sessionID: session.id,
          messageID: firstAssistant.id,
          callID: "call_superseded",
        })
        // Turn two supersedes it, so a latest-message-only repair never revisits
        // turn one.
        const secondRoot = await writeRoot(session.id)
        const secondAssistant = await writeAssistant(session.id, secondRoot.id, "error")

        await SessionInvoke.repairAfterAbort(session.id)

        // Both the superseded part and the newest turn's state are consistent.
        expect((await readToolPart(session.id, firstAssistant.id, orphaned)).state.status).toBe("error")
        expect(await findToolPart(session.id, secondAssistant.id, orphaned)).toBeUndefined()
      },
    })
  })

  test("leaves an unsettled part on a non-terminal message alone", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeRoot(session.id)
        // A live turn's part belongs to the processor, not to this repair: the
        // session-wide sweep must not touch a message that can still complete.
        const live = await writeAssistant(session.id, root.id)
        const partID = await writeRunningToolPart({
          sessionID: session.id,
          messageID: live.id,
          callID: "call_live_turn",
        })
        // Give the session a different terminal turn so repair has work to do.
        const otherRoot = await writeRoot(session.id)
        const terminal = await writeAssistant(session.id, otherRoot.id, "error")

        await SessionInvoke.repairAfterAbort(session.id)

        expect((await readToolPart(session.id, live.id, partID)).state.status).toBe("running")
        expect(await findToolPart(session.id, terminal.id, partID)).toBeUndefined()
      },
    })
  })

  test("is idempotent when the repair runs repeatedly", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeRoot(session.id)
        const assistant = await writeAssistant(session.id, root.id, "error")
        const partID = await writeRunningToolPart({
          sessionID: session.id,
          messageID: assistant.id,
          callID: "call_idempotent",
        })

        await SessionInvoke.repairAfterAbort(session.id)
        const first = await readToolPart(session.id, assistant.id, partID)
        if (first.state.status !== "error") throw new Error("expected error state")
        const firstEnd = first.state.time.end

        await SessionInvoke.repairAfterAbort(session.id)
        const second = await readToolPart(session.id, assistant.id, partID)
        if (second.state.status !== "error") throw new Error("expected error state")
        expect(second.state.time.end).toBe(firstEnd)
      },
    })
  })
})
