import { describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutRecordingError } from "../../src/session/rollout/error"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

describe("session tool output evidence", () => {
  test("archives output before the session preview is bounded", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        let removed = false
        try {
          const output = "a".repeat(65_535) + "🧪" + "b".repeat(40_000)
          const root = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            time: { created: 0 },
          })
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: root.id,
            agent: "test",
            mode: "test",
            modelID: "test",
            providerID: "test",
            time: { created: 1, completed: 2 },
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })
          const part = await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: assistant.id,
            type: "tool",
            callID: "tool-call",
            tool: "read",
            state: { status: "completed", input: {}, output, title: "read", metadata: {}, time: { start: 0, end: 1 } },
          })
          if (part.type !== "tool" || part.state.status !== "completed") throw new Error("Expected completed tool")
          expect(part.state.output.length).toBeLessThan(output.length)
          expect(part.state.outputArtifact).toBeDefined()
          const chunks: Uint8Array[] = []
          for await (const chunk of RolloutArtifact.read(
            { kind: "session", scopeID: scope.id, sessionID: session.id },
            part.state.outputArtifact!.id,
          ))
            chunks.push(chunk)
          expect(Buffer.concat(chunks).toString("utf8")).toBe(output)
          const pruned = await Session.updatePart({
            ...part,
            state: { ...part.state, time: { ...part.state.time, compacted: 2 } },
          })
          if (pruned.type !== "tool" || pruned.state.status !== "completed") throw new Error("Expected completed tool")
          expect(pruned.state.outputArtifact).toEqual(part.state.outputArtifact)
          expect(
            await RolloutArtifact.list({ kind: "session", scopeID: scope.id, sessionID: session.id }),
          ).toHaveLength(1)
          const fork = await Session.fork({ sessionID: session.id })
          try {
            await Session.remove(session.id)
            removed = true
            const messages = await Session.messages({ sessionID: fork.id })
            const copied = messages.flatMap((message) => message.parts).find((item) => item.type === "tool")
            if (!copied || copied.type !== "tool" || copied.state.status !== "completed")
              throw new Error("Expected copied tool")
            const bytes: Uint8Array[] = []
            for await (const chunk of RolloutArtifact.read(
              { kind: "session", scopeID: scope.id, sessionID: fork.id },
              copied.state.outputArtifact!.id,
            ))
              bytes.push(chunk)
            expect(Buffer.concat(bytes).toString("utf8")).toBe(output)
          } finally {
            await Session.remove(fork.id)
          }
        } finally {
          if (!removed) await Session.remove(session.id)
        }
      },
    })
  })

  test("does not persist successful tool state when recording fails", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const lease = SessionManager.acquire(session.id)
        if (!lease) throw new Error("Expected execution lease")
        try {
          const part: MessageV2.ToolPart = {
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: Identifier.ascending("message"),
            type: "tool",
            callID: "tool-call",
            tool: "read",
            state: {
              status: "completed",
              input: {},
              output: "evidence",
              title: "read",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          }
          await Session.updateMessage({
            id: part.messageID,
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            time: { created: 0 },
          })
          SessionManager.bindRootTask(lease, part.messageID)
          using write = spyOn(Storage, "writeBinary").mockRejectedValue(
            Object.assign(new Error("disk full"), { code: "ENOSPC" }),
          )
          await expect(Session.updatePart(part)).rejects.toBeInstanceOf(RolloutRecordingError)
          expect(lease.signal.aborted).toBe(true)
          await expect(
            Storage.read(
              StoragePath.messagePart(
                Identifier.asScopeID(scope.id),
                Identifier.asSessionID(session.id),
                Identifier.asMessageID(part.messageID),
                Identifier.asPartID(part.id),
              ),
            ),
          ).rejects.toBeInstanceOf(Storage.NotFoundError)
        } finally {
          await SessionManager.release(lease)
          await Session.remove(session.id)
        }
      },
    })
  })
})
