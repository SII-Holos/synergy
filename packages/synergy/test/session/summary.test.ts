import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LoopJob } from "../../src/session/loop-job"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotSchema } from "../../src/session/snapshot-schema"
import { tmpdir } from "../fixture/fixture"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

const originalDiffSummary = Snapshot.diffSummary
const originalGetModel = Provider.getModel
const originalMessages = Session.messages

function summarizeFromLoop(input: { sessionID: string; messageID: string; messages: MessageV2.WithParts[] }) {
  const summary = SessionSummary as typeof SessionSummary & {
    summarizeFromLoop: (input: {
      sessionID: string
      messageID: string
      messages: MessageV2.WithParts[]
    }) => Promise<void>
  }
  return summary.summarizeFromLoop(input)
}

afterEach(() => {
  ;(Snapshot.diffSummary as any) = originalDiffSummary
  ;(Provider.getModel as any) = originalGetModel
  ;(Session.messages as any) = originalMessages
})

describe("SessionSummary", () => {
  test("post job only collects for terminal assistant replies", async () => {
    const session = { id: "session_1" } as any
    const lastUser = { id: "msg_user", sessionID: "session_1", role: "user" } as MessageV2.User
    const base = {
      session,
      sessionID: "session_1",
      step: 1,
      messages: [],
      lastUser,
      lastUserParts: [],
      abort: new AbortController().signal,
    }

    expect(
      LoopJob.collect("post", {
        ...base,
        lastAssistant: { id: "msg_a", sessionID: "session_1", role: "assistant", finish: "tool-calls" } as any,
      }),
    ).toEqual([])

    expect(
      LoopJob.collect("post", {
        ...base,
        lastAssistant: { id: "msg_b", sessionID: "session_1", role: "assistant", finish: "stop" } as any,
      }),
    ).toEqual([{ type: "summarize" }])
  })

  test("reuses one diffSummary result when session and message ranges match", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Summary diff cache" })
        const user = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
        })) as MessageV2.User
        const assistant = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: user.id,
          rootID: user.id,
          modelID: "kimi-k2-thinking",
          providerID: "moonshotai-cn",
          time: { created: Date.now() },
          mode: "synergy",
          agent: "synergy",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })) as MessageV2.Assistant
        const file = path.join(tmp.path, "file.txt")
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant.id,
          sessionID: session.id,
          type: "step-start",
          snapshot: "from_tree",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant.id,
          sessionID: session.id,
          type: "step-finish",
          reason: "tool-calls",
          snapshot: "to_tree",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant.id,
          sessionID: session.id,
          type: "patch",
          hash: "from_tree",
          files: [file],
        })

        const diff = SnapshotSchema.fromPatch({
          file: "file.txt",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "diff --git a/file.txt b/file.txt\n@@ -0,0 +1 @@\n+content\n",
          afterBytes: 8,
        })
        const diffSummary = mock(async () => [diff])
        ;(Snapshot.diffSummary as any) = diffSummary
        ;(Provider.getModel as any) = mock(async (providerID: string, modelID: string) => ({
          id: modelID,
          providerID,
          name: "Test Model",
          limit: { context: 100_000, output: 8_192 },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: {
            toolcall: true,
            attachment: false,
            reasoning: false,
            temperature: true,
            input: { text: true, image: false, audio: false, video: false },
            output: { text: true, image: false, audio: false, video: false },
          },
          api: { npm: "@ai-sdk/openai", id: modelID },
          options: {},
        }))

        await SessionSummary.summarize({
          sessionID: session.id,
          messageID: user.id,
        })

        expect(diffSummary).toHaveBeenCalledTimes(1)
        expect((diffSummary.mock.calls[0] as unknown[]).slice(0, 3)).toEqual(["from_tree", "to_tree", session.id])

        const messages = await Session.messages({ sessionID: session.id })
        const storedUser = messages.find((message) => message.info.id === user.id)?.info as MessageV2.User | undefined
        expect(storedUser?.summary?.diffs).toEqual([diff])

        await Session.remove(session.id)
      },
    })
  })

  test("extends the session diff cursor from bounded loop messages", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Bounded summary history" })
        const file = path.join(tmp.path, "file.txt")
        const writeTurn = async (index: number) => {
          const user = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            summary: { title: `Turn ${index}`, diffs: [] },
          })) as MessageV2.User
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: `turn ${index}`,
          })
          const assistant = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            rootID: user.id,
            modelID: "test",
            providerID: "test",
            time: { created: Date.now(), completed: Date.now() },
            mode: "synergy",
            agent: "synergy",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })) as MessageV2.Assistant
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-start",
            snapshot: `from_${index}`,
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-finish",
            reason: "tool-calls",
            snapshot: `to_${index}`,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "patch",
            hash: `from_${index}`,
            files: [file],
          })
          return {
            user,
            messages: [
              { info: user, parts: await MessageV2.parts({ sessionID: session.id, messageID: user.id }) },
              { info: assistant, parts: await MessageV2.parts({ sessionID: session.id, messageID: assistant.id }) },
            ],
          }
        }

        const diff = SnapshotSchema.fromPatch({
          file: "file.txt",
          additions: 1,
          deletions: 0,
          patch: "diff --git a/file.txt b/file.txt\n@@ -0,0 +1 @@\n+content\n",
        })
        const diffSummary = mock(async () => [diff])
        ;(Snapshot.diffSummary as any) = diffSummary

        const first = await writeTurn(1)
        await summarizeFromLoop({ sessionID: session.id, messageID: first.user.id, messages: first.messages })
        ;(Session.messages as any) = mock(async () => {
          throw new Error("bounded summary must not reload the full transcript")
        })
        const second = await writeTurn(2)
        await summarizeFromLoop({ sessionID: session.id, messageID: second.user.id, messages: second.messages })

        expect(diffSummary).toHaveBeenCalledTimes(3)
        const ranges = diffSummary.mock.calls.map((call) => (call as unknown[]).slice(0, 3))
        expect(ranges).toContainEqual(["from_2", "to_2", session.id])
        expect(ranges).toContainEqual(["from_1", "to_2", session.id])
        expect((await Session.get(session.id)).summary).toEqual({ additions: 1, deletions: 0, files: 1 })

        const cursorPath = StoragePath.sessionSummaryCursor(
          Identifier.asScopeID(scope.id),
          Identifier.asSessionID(session.id),
        )
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        ;(Snapshot.diffSummary as any) = mock(async () => {
          entered.resolve()
          await release.promise
          return [diff]
        })
        const third = await writeTurn(3)
        const summarizing = summarizeFromLoop({
          sessionID: session.id,
          messageID: third.user.id,
          messages: third.messages,
        })
        await entered.promise
        await Session.rollback({ sessionID: session.id, numTurns: 1 })
        release.resolve()
        await summarizing
        await expect(Storage.read(cursorPath)).rejects.toBeInstanceOf(Storage.NotFoundError)

        await Session.remove(session.id)
      },
    })
  })

  test("recovers after a failed summarize instead of wedging the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Summary recovery" })
        const user = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
        })) as MessageV2.User
        const assistant = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: user.id,
          rootID: user.id,
          modelID: "kimi-k2-thinking",
          providerID: "moonshotai-cn",
          time: { created: Date.now() },
          mode: "synergy",
          agent: "synergy",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })) as MessageV2.Assistant
        const file = path.join(tmp.path, "file.txt")
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant.id,
          sessionID: session.id,
          type: "step-start",
          snapshot: "from_tree",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant.id,
          sessionID: session.id,
          type: "step-finish",
          reason: "tool-calls",
          snapshot: "to_tree",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant.id,
          sessionID: session.id,
          type: "patch",
          hash: "from_tree",
          files: [file],
        })

        const diff = SnapshotSchema.fromPatch({
          file: "file.txt",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "diff --git a/file.txt b/file.txt\n@@ -0,0 +1 @@\n+content\n",
          afterBytes: 8,
        })
        let calls = 0
        const diffSummary = mock(async () => {
          calls++
          if (calls === 1) throw new Error("transient diff failure")
          return [diff]
        })
        ;(Snapshot.diffSummary as any) = diffSummary
        ;(Provider.getModel as any) = mock(async (providerID: string, modelID: string) => ({
          id: modelID,
          providerID,
          name: "Test Model",
          limit: { context: 100_000, output: 8_192 },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: {
            toolcall: true,
            attachment: false,
            reasoning: false,
            temperature: true,
            input: { text: true, image: false, audio: false, video: false },
            output: { text: true, image: false, audio: false, video: false },
          },
          api: { npm: "@ai-sdk/openai", id: modelID },
          options: {},
        }))

        // First run fails inside summarize; it must settle (not reject) and must
        // not leave the session wedged so the entry is never drained.
        await SessionSummary.summarize({ sessionID: session.id, messageID: user.id })

        // A subsequent run must actually execute again rather than returning the
        // previous (failed) coalesced promise forever.
        await SessionSummary.summarize({ sessionID: session.id, messageID: user.id })

        expect(diffSummary.mock.calls.length).toBeGreaterThanOrEqual(2)
        const messages = await Session.messages({ sessionID: session.id })
        const storedUser = messages.find((message) => message.info.id === user.id)?.info as MessageV2.User | undefined
        expect(storedUser?.summary?.diffs).toEqual([diff])

        await Session.remove(session.id)
      },
    })
  })

  test("a hung summarize run times out and does not wedge the session", async () => {
    const previousTimeout = process.env.SYNERGY_SUMMARY_TIMEOUT_MS
    process.env.SYNERGY_SUMMARY_TIMEOUT_MS = "100"
    await using tmp = await tmpdir({ git: true })
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Summary hang" })
          const user = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
          })) as MessageV2.User
          const assistant = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            rootID: user.id,
            modelID: "kimi-k2-thinking",
            providerID: "moonshotai-cn",
            time: { created: Date.now() },
            mode: "synergy",
            agent: "synergy",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })) as MessageV2.Assistant
          const file = path.join(tmp.path, "file.txt")
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-start",
            snapshot: "from_tree",
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-finish",
            reason: "tool-calls",
            snapshot: "to_tree",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "patch",
            hash: "from_tree",
            files: [file],
          })

          const diff = SnapshotSchema.fromPatch({
            file: "file.txt",
            additions: 1,
            deletions: 0,
            binary: false,
            patch: "diff --git a/file.txt b/file.txt\n@@ -0,0 +1 @@\n+content\n",
            afterBytes: 8,
          })
          let calls = 0
          const diffSummary = mock(async () => {
            calls++
            // First run hangs forever; the per-run timeout must unblock the
            // coalescing loop so `active` clears and later runs still execute.
            if (calls === 1) return new Promise<never>(() => {})
            return [diff]
          })
          ;(Snapshot.diffSummary as any) = diffSummary
          ;(Provider.getModel as any) = mock(async (providerID: string, modelID: string) => ({
            id: modelID,
            providerID,
            name: "Test Model",
            limit: { context: 100_000, output: 8_192 },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            capabilities: {
              toolcall: true,
              attachment: false,
              reasoning: false,
              temperature: true,
              input: { text: true, image: false, audio: false, video: false },
              output: { text: true, image: false, audio: false, video: false },
            },
            api: { npm: "@ai-sdk/openai", id: modelID },
            options: {},
          }))

          // First run hangs internally; summarize() must still settle (via the
          // per-run timeout) rather than block forever.
          await SessionSummary.summarize({ sessionID: session.id, messageID: user.id })
          // Session is not wedged: a subsequent run executes and persists.
          await SessionSummary.summarize({ sessionID: session.id, messageID: user.id })

          expect(calls).toBeGreaterThanOrEqual(2)
          const messages = await Session.messages({ sessionID: session.id })
          const storedUser = messages.find((message) => message.info.id === user.id)?.info as MessageV2.User | undefined
          expect(storedUser?.summary?.diffs).toEqual([diff])

          await Session.remove(session.id)
        },
      })
    } finally {
      if (previousTimeout === undefined) delete process.env.SYNERGY_SUMMARY_TIMEOUT_MS
      else process.env.SYNERGY_SUMMARY_TIMEOUT_MS = previousTimeout
    }
  })
})
