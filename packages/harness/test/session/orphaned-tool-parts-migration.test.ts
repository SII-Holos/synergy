import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { MessageV2 } from "../../src/session/message-v2"
import { migrations } from "../../src/session/migration"
import { tmpdir } from "../support/fixture"

const projectRoot = new URL("../..", import.meta.url).pathname

const MIGRATION_ID = "20260919-settle-orphaned-tool-parts"

async function runMigration(id: string) {
  const migration = migrations.find((candidate) => candidate.id === id)
  if (!migration) throw new Error(`migration not found: ${id}`)
  await migration.up(() => {})
}

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

describe("orphaned tool part migration", () => {
  test("settles a running part on an already-terminal assistant message", async () => {
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
          callID: "call_hist_1",
        })

        await runMigration(MIGRATION_ID)

        const part = await readToolPart(session.id, assistant.id, partID)
        expect(part.state.status).toBe("error")
        if (part.state.status !== "error") throw new Error("expected error state")
        expect(part.state.error).toBe(MessageV2.INTERRUPTED_TOOL_ERROR)
        expect(part.state.time.end).toBeNumber()
      },
    })
  })

  test("leaves a running part on a non-terminal message alone, since that turn is legitimately unfinished", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeRoot(session.id)
        const assistant = await writeAssistant(session.id, root.id)
        const partID = await writeRunningToolPart({
          sessionID: session.id,
          messageID: assistant.id,
          callID: "call_hist_unfinished",
        })

        await runMigration(MIGRATION_ID)

        expect((await readToolPart(session.id, assistant.id, partID)).state.status).toBe("running")
      },
    })
  })

  test("leaves completed parts untouched and reports progress across parts", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeRoot(session.id)
        const assistant = await writeAssistant(session.id, root.id, "stop")
        const partID = Identifier.ascending("part")
        await Session.updatePart({
          id: partID,
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_hist_completed",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: "ok",
            title: "ok",
            metadata: {},
            time: { start: Date.now() - 500, end: Date.now() - 400 },
          },
        })

        const progress: Array<{ current: number; total: number }> = []
        const migration = migrations.find((candidate) => candidate.id === MIGRATION_ID)!
        await migration.up((current, total) => progress.push({ current, total }))

        expect((await readToolPart(session.id, assistant.id, partID)).state.status).toBe("completed")
        expect(progress.length).toBeGreaterThan(0)
      },
    })
  })

  test("is idempotent across repeated runs", async () => {
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
          callID: "call_hist_idempotent",
        })

        await runMigration(MIGRATION_ID)
        const first = await readToolPart(session.id, assistant.id, partID)
        if (first.state.status !== "error") throw new Error("expected error state")
        const firstEnd = first.state.time.end

        await runMigration(MIGRATION_ID)
        const second = await readToolPart(session.id, assistant.id, partID)
        if (second.state.status !== "error") throw new Error("expected error state")
        expect(second.state.time.end).toBe(firstEnd)
      },
    })
  })

  test("does not fail on a fresh install with no parts", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Session.create({})
        await expect(runMigration(MIGRATION_ID)).resolves.toBeUndefined()
      },
    })
  })

  test("keys the write back to the same part record", async () => {
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
          callID: "call_hist_key",
        })
        const scopeID = Identifier.asScopeID(session.scope.id)
        const key = StoragePath.messagePart(
          scopeID,
          Identifier.asSessionID(session.id),
          Identifier.asMessageID(assistant.id),
          Identifier.asPartID(partID),
        )

        await runMigration(MIGRATION_ID)

        // The migration must rewrite the record in place rather than leaving a
        // stale `running` record behind under the original key.
        const stored = await Storage.read<MessageV2.Part>(key)
        if (stored.type !== "tool") throw new Error("expected tool part")
        expect(stored.state.status).toBe("error")
      },
    })
  })
})
