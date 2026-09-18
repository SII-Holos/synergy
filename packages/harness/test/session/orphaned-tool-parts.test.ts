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
