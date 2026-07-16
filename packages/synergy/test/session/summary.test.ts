import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LoopJob } from "../../src/session/loop-job"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotSchema } from "../../src/session/snapshot-schema"
import { tmpdir } from "../fixture/fixture"

const originalDiffSummary = Snapshot.diffSummary
const originalGetModel = Provider.getModel

afterEach(() => {
  ;(Snapshot.diffSummary as any) = originalDiffSummary
  ;(Provider.getModel as any) = originalGetModel
})

function testModel(providerID: string, modelID: string) {
  return {
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
  }
}

function installTestModel() {
  ;(Provider.getModel as any) = mock(async (providerID: string, modelID: string) => testModel(providerID, modelID))
}

async function createTurn(input: {
  sessionID: string
  directory: string
  index: number
  text?: string
  finish?: "stop" | "tool-calls"
}) {
  const user = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  })) as MessageV2.User
  if (input.text) {
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: user.id,
      sessionID: input.sessionID,
      type: "text",
      text: input.text,
    })
  }

  const assistant = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    role: "assistant",
    parentID: user.id,
    rootID: user.id,
    modelID: "kimi-k2-thinking",
    providerID: "moonshotai-cn",
    time: { created: Date.now() },
    mode: "synergy",
    agent: "synergy",
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })) as MessageV2.Assistant
  const from = `from_tree_${input.index}`
  const to = `to_tree_${input.index}`
  const relativeFile = `file-${input.index}.txt`
  const file = path.join(input.directory, relativeFile)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "step-start",
    snapshot: from,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "step-finish",
    reason: input.finish ?? "tool-calls",
    snapshot: to,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "patch",
    hash: from,
    files: [file],
  })
  const diff = SnapshotSchema.fromPatch({
    file: relativeFile,
    additions: 1,
    deletions: 0,
    binary: false,
    patch: `diff --git a/${relativeFile} b/${relativeFile}\n@@ -0,0 +1 @@\n+content\n`,
    afterBytes: 8,
  })
  return { user, assistant, from, to, diff }
}

async function createContinuation(input: {
  sessionID: string
  directory: string
  root: MessageV2.User
  index: number
}) {
  const steer = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    role: "user",
    isRoot: false,
    rootID: input.root.id,
    visible: false,
    time: { created: Date.now() },
    agent: input.root.agent,
    model: input.root.model,
  })) as MessageV2.User
  const assistant = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    role: "assistant",
    parentID: input.root.id,
    rootID: input.root.id,
    modelID: "kimi-k2-thinking",
    providerID: "moonshotai-cn",
    time: { created: Date.now() },
    mode: "synergy",
    agent: "synergy",
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })) as MessageV2.Assistant
  const from = `from_tree_${input.index}`
  const to = `to_tree_${input.index}`
  const relativeFile = `file-${input.index}.txt`
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "step-start",
    snapshot: from,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "step-finish",
    reason: "stop",
    snapshot: to,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const diff = SnapshotSchema.fromPatch({
    file: relativeFile,
    additions: 1,
    deletions: 0,
    binary: false,
    patch: `diff --git a/${relativeFile} b/${relativeFile}\n@@ -0,0 +1 @@\n+continued\n`,
    afterBytes: 10,
  })
  return { steer, assistant, from, to, diff }
}

async function storedUser(sessionID: string, messageID: string) {
  const messages = await Session.messages({ sessionID })
  return messages.find((message) => message.info.id === messageID)?.info as MessageV2.User | undefined
}

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
  test("writes pending before diff resolves", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Pending turn diff" })
        const turn = await createTurn({ sessionID: session.id, directory: tmp.path, index: 1 })
        const diffStarted = Promise.withResolvers<void>()
        const diffResult = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
        ;(Snapshot.diffSummary as any) = mock(async () => {
          diffStarted.resolve()
          return diffResult.promise
        })
        installTestModel()

        const summarizing = SessionSummary.summarize({ sessionID: session.id, messageID: turn.user.id })
        await diffStarted.promise
        const pending = await storedUser(session.id, turn.user.id)
        diffResult.resolve([turn.diff])
        await summarizing

        expect(pending?.summary?.diffState).toEqual({
          status: "pending",
          deadlineAt: expect.any(Number),
        })
        expect((pending?.summary?.diffState as { deadlineAt?: number } | undefined)?.deadlineAt).toBeGreaterThan(
          Date.now(),
        )

        await Session.remove(session.id)
      },
    })
  })

  test("writes ready diffs before title and body resolve", async () => {
    const originalStream = LLM.stream
    await using tmp = await tmpdir({ git: true })
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Ready before enrichment" })
          const turn = await createTurn({
            sessionID: session.id,
            directory: tmp.path,
            index: 2,
            text: "Summarize this turn",
            finish: "stop",
          })
          ;(Snapshot.diffSummary as any) = mock(async () => [turn.diff])
          installTestModel()
          const llmStarted = Promise.withResolvers<void>()
          const llmText = Promise.withResolvers<string>()
          ;(LLM.stream as any) = mock(async () => {
            llmStarted.resolve()
            return { text: llmText.promise }
          })

          const summarizing = SessionSummary.summarize({ sessionID: session.id, messageID: turn.user.id })
          await llmStarted.promise
          const beforeEnrichment = await storedUser(session.id, turn.user.id)
          llmText.resolve("Generated summary")
          await summarizing

          expect(beforeEnrichment?.summary?.diffs).toEqual([turn.diff])
          expect(beforeEnrichment?.summary?.diffState).toEqual({ status: "ready" })
          expect(beforeEnrichment?.summary?.title).toBeUndefined()
          expect(beforeEnrichment?.summary?.body).toBeUndefined()

          await Session.remove(session.id)
        },
      })
    } finally {
      ;(LLM.stream as any) = originalStream
    }
  })

  test("preserves ready diffs when session aggregation exceeds the run timeout", async () => {
    const previousTimeout = process.env.SYNERGY_SUMMARY_TIMEOUT_MS
    process.env.SYNERGY_SUMMARY_TIMEOUT_MS = "50"
    await using tmp = await tmpdir({ git: true })
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Ready before timeout" })
          const first = await createTurn({ sessionID: session.id, directory: tmp.path, index: 15 })
          const second = await createTurn({ sessionID: session.id, directory: tmp.path, index: 16 })
          const messageDiffReady = Promise.withResolvers<void>()
          const sessionDiffStarted = Promise.withResolvers<void>()
          const sessionDiff = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
          ;(Snapshot.diffSummary as any) = mock(async (from: string, to: string) => {
            if (from === second.from && to === second.to) {
              messageDiffReady.resolve()
              return [second.diff]
            }
            if (from === first.from && to === second.to) {
              sessionDiffStarted.resolve()
              return sessionDiff.promise
            }
            return []
          })
          installTestModel()

          const summarizing = SessionSummary.summarize({ sessionID: session.id, messageID: second.user.id })
          await Promise.all([messageDiffReady.promise, sessionDiffStarted.promise])
          expect((await storedUser(session.id, second.user.id))?.summary?.diffState).toEqual({ status: "ready" })
          await summarizing
          sessionDiff.resolve([first.diff, second.diff])

          expect((await storedUser(session.id, second.user.id))?.summary?.diffState).toEqual({ status: "ready" })

          await Session.remove(session.id)
        },
      })
    } finally {
      if (previousTimeout === undefined) delete process.env.SYNERGY_SUMMARY_TIMEOUT_MS
      else process.env.SYNERGY_SUMMARY_TIMEOUT_MS = previousTimeout
    }
  })

  test("writes ready with empty diffs", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Empty turn diff" })
        const turn = await createTurn({ sessionID: session.id, directory: tmp.path, index: 3 })
        ;(Snapshot.diffSummary as any) = mock(async () => [])
        installTestModel()

        await SessionSummary.summarize({ sessionID: session.id, messageID: turn.user.id })

        const stored = await storedUser(session.id, turn.user.id)
        expect(stored?.summary?.diffs).toEqual([])
        expect(stored?.summary?.diffState).toEqual({ status: "ready" })

        await Session.remove(session.id)
      },
    })
  })

  test("writes a safe diff error and continues the queued turn", async () => {
    const originalStream = LLM.stream
    await using tmp = await tmpdir({ git: true })
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Diff error queue" })
          const first = await createTurn({
            sessionID: session.id,
            directory: tmp.path,
            index: 4,
            text: "Keep generating the title",
          })
          const second = await createTurn({ sessionID: session.id, directory: tmp.path, index: 5 })
          const firstDiffStarted = Promise.withResolvers<void>()
          const firstDiff = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
          ;(Snapshot.diffSummary as any) = mock(async (from: string, to: string) => {
            if (from === first.from && to === first.to) {
              firstDiffStarted.resolve()
              return firstDiff.promise
            }
            if (from === second.from && to === second.to) return [second.diff]
            return [first.diff, second.diff]
          })
          installTestModel()
          ;(LLM.stream as any) = mock(async () => ({ text: Promise.resolve("Recovered title") }))

          const firstRun = SessionSummary.summarize({ sessionID: session.id, messageID: first.user.id })
          await firstDiffStarted.promise
          const secondRun = SessionSummary.summarize({ sessionID: session.id, messageID: second.user.id })
          firstDiff.reject(new Error("git failed at /private/worktree and leaked stderr"))
          await Promise.all([firstRun, secondRun])

          const failed = await storedUser(session.id, first.user.id)
          const queued = await storedUser(session.id, second.user.id)
          expect(failed?.summary?.diffState).toEqual({ status: "error", code: "git_failure" })
          expect(failed?.summary?.title).toBe("Recovered title")
          expect(JSON.stringify(failed?.summary)).not.toContain("/private/worktree")
          expect(JSON.stringify(failed?.summary)).not.toContain("stderr")
          expect(queued?.summary?.diffs).toEqual([second.diff])
          expect(queued?.summary?.diffState).toEqual({ status: "ready" })

          await Session.remove(session.id)
        },
      })
    } finally {
      ;(LLM.stream as any) = originalStream
    }
  })

  test("fresh summary merge preserves concurrent fields", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Concurrent summary merge" })
        const turn = await createTurn({ sessionID: session.id, directory: tmp.path, index: 6 })
        const diffStarted = Promise.withResolvers<void>()
        const diffResult = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
        ;(Snapshot.diffSummary as any) = mock(async () => {
          diffStarted.resolve()
          return diffResult.promise
        })
        installTestModel()

        const summarizing = SessionSummary.summarize({ sessionID: session.id, messageID: turn.user.id })
        await diffStarted.promise
        const pending = await storedUser(session.id, turn.user.id)
        await Session.updateMessage({
          ...pending!,
          summary: {
            diffs: pending?.summary?.diffs ?? [],
            diffState: pending?.summary?.diffState,
            title: "Concurrent title",
            body: "Concurrent body",
          },
        })
        diffResult.resolve([turn.diff])
        await summarizing

        const stored = await storedUser(session.id, turn.user.id)
        expect(stored?.summary).toMatchObject({
          title: "Concurrent title",
          body: "Concurrent body",
          diffs: [turn.diff],
          diffState: { status: "ready" },
        })

        await Session.remove(session.id)
      },
    })
  })

  test("processes every queued message in FIFO order", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Summary FIFO" })
        const turns: Array<Awaited<ReturnType<typeof createTurn>>> = []
        for (const index of [7, 8, 9]) {
          turns.push(await createTurn({ sessionID: session.id, directory: tmp.path, index }))
        }
        const firstDiffStarted = Promise.withResolvers<void>()
        const firstDiff = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
        const order: string[] = []
        ;(Snapshot.diffSummary as any) = mock(async (from: string, to: string) => {
          const turn = turns.find((item) => item.from === from && item.to === to)
          if (!turn) return turns.map((item) => item.diff)
          order.push(turn.user.id)
          if (turn === turns[0]) {
            firstDiffStarted.resolve()
            return firstDiff.promise
          }
          return [turn.diff]
        })
        installTestModel()

        const firstRun = SessionSummary.summarize({ sessionID: session.id, messageID: turns[0].user.id })
        await firstDiffStarted.promise
        const secondRun = SessionSummary.summarize({ sessionID: session.id, messageID: turns[1].user.id })
        const thirdRun = SessionSummary.summarize({ sessionID: session.id, messageID: turns[2].user.id })
        firstDiff.resolve([turns[0].diff])
        await Promise.all([firstRun, secondRun, thirdRun])

        expect(order).toEqual(turns.map((turn) => turn.user.id))
        for (const turn of turns) {
          expect((await storedUser(session.id, turn.user.id))?.summary?.diffState).toEqual({ status: "ready" })
        }

        await Session.remove(session.id)
      },
    })
  })

  test("re-runs the same root for a later terminal assistant revision", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Same-root continuation" })
        const first = await createTurn({ sessionID: session.id, directory: tmp.path, index: 11 })
        const firstStarted = Promise.withResolvers<void>()
        const firstResult = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
        let continuation: Awaited<ReturnType<typeof createContinuation>> | undefined
        const ranges: string[] = []
        ;(Snapshot.diffSummary as any) = mock(async (from: string, to: string) => {
          ranges.push(`${from}:${to}`)
          if (from === first.from && to === first.to) {
            firstStarted.resolve()
            return firstResult.promise
          }
          if (continuation && from === first.from && to === continuation.to) {
            return [first.diff, continuation.diff]
          }
          return []
        })
        installTestModel()

        const firstRun = SessionSummary.summarize({
          sessionID: session.id,
          messageID: first.user.id,
          revisionID: first.assistant.id,
        })
        await firstStarted.promise
        continuation = await createContinuation({
          sessionID: session.id,
          directory: tmp.path,
          root: first.user,
          index: 12,
        })
        const secondRun = SessionSummary.summarize({
          sessionID: session.id,
          messageID: first.user.id,
          revisionID: continuation.assistant.id,
        })
        firstResult.resolve([first.diff])
        await Promise.all([firstRun, secondRun])

        expect((await storedUser(session.id, first.user.id))?.summary?.diffs).toEqual([first.diff, continuation.diff])
        expect(ranges).toContain(`${first.from}:${continuation.to}`)

        await Session.remove(session.id)
      },
    })
  })

  test("times out the worker before advancing and rejects late writes", async () => {
    const previousTimeout = process.env.SYNERGY_SUMMARY_TIMEOUT_MS
    process.env.SYNERGY_SUMMARY_TIMEOUT_MS = "50"
    await using tmp = await tmpdir({ git: true })
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Timeout ordering" })
          const first = await createTurn({ sessionID: session.id, directory: tmp.path, index: 13 })
          const second = await createTurn({ sessionID: session.id, directory: tmp.path, index: 14 })
          const firstMessageStarted = Promise.withResolvers<void>()
          const firstMessageResult = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
          const firstSessionResult = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
          let fullRangeCalls = 0
          ;(Snapshot.diffSummary as any) = mock(async (from: string, to: string) => {
            if (from === first.from && to === first.to) {
              firstMessageStarted.resolve()
              return firstMessageResult.promise
            }
            if (from === first.from && to === second.to) {
              fullRangeCalls++
              if (fullRangeCalls === 1) return firstSessionResult.promise
              return [first.diff, second.diff]
            }
            if (from === second.from && to === second.to) return [second.diff]
            return []
          })
          installTestModel()

          const firstRun = SessionSummary.summarize({
            sessionID: session.id,
            messageID: first.user.id,
            revisionID: first.assistant.id,
          })
          await firstMessageStarted.promise
          const secondRun = SessionSummary.summarize({
            sessionID: session.id,
            messageID: second.user.id,
            revisionID: second.assistant.id,
          })
          await Promise.all([firstRun, secondRun])

          expect((await storedUser(session.id, first.user.id))?.summary?.diffState).toEqual({
            status: "error",
            code: "timeout",
          })
          expect(await SessionSummary.diff({ sessionID: session.id })).toEqual([first.diff, second.diff])

          firstMessageResult.resolve([first.diff])
          firstSessionResult.resolve([first.diff])
          await Bun.sleep(10)

          expect(await SessionSummary.diff({ sessionID: session.id })).toEqual([first.diff, second.diff])

          await Session.remove(session.id)
        },
      })
    } finally {
      if (previousTimeout === undefined) delete process.env.SYNERGY_SUMMARY_TIMEOUT_MS
      else process.env.SYNERGY_SUMMARY_TIMEOUT_MS = previousTimeout
    }
  })

  test("projects clearly expired pending settlements as timeout errors", () => {
    const expired = MessageV2.canonicalMessage<MessageV2.User>({
      id: "msg_expired",
      sessionID: "ses_expired",
      role: "user",
      time: { created: Date.now() - 300_000 },
      agent: "synergy",
      model: { providerID: "test", modelID: "test" },
      summary: {
        diffs: [],
        diffState: { status: "pending", deadlineAt: Date.now() - 180_000 },
      },
    })

    expect(expired.summary?.diffState).toEqual({ status: "error", code: "timeout" })
  })

  test("keeps unexpired pending settlements pending", () => {
    const pending = MessageV2.canonicalMessage<MessageV2.User>({
      id: "msg_pending",
      sessionID: "ses_pending",
      role: "user",
      time: { created: Date.now() },
      agent: "synergy",
      model: { providerID: "test", modelID: "test" },
      summary: {
        diffs: [],
        diffState: { status: "pending", deadlineAt: Date.now() + 60_000 },
      },
    })

    expect(pending.summary?.diffState?.status).toBe("pending")
  })

  test("deduplicates a messageID already in the current run", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Summary deduplication" })
        const turn = await createTurn({ sessionID: session.id, directory: tmp.path, index: 10 })
        const firstDiffStarted = Promise.withResolvers<void>()
        const firstDiff = Promise.withResolvers<SnapshotSchema.FileDiff[]>()
        let messageDiffCalls = 0
        ;(Snapshot.diffSummary as any) = mock(async (from: string, to: string) => {
          if (from !== turn.from || to !== turn.to) return [turn.diff]
          messageDiffCalls++
          if (messageDiffCalls === 1) {
            firstDiffStarted.resolve()
            return firstDiff.promise
          }
          return [turn.diff]
        })
        installTestModel()

        const firstRun = SessionSummary.summarize({ sessionID: session.id, messageID: turn.user.id })
        await firstDiffStarted.promise
        const duplicateRun = SessionSummary.summarize({ sessionID: session.id, messageID: turn.user.id })
        firstDiff.resolve([turn.diff])
        await Promise.all([firstRun, duplicateRun])

        expect(messageDiffCalls).toBe(1)

        await Session.remove(session.id)
      },
    })
  })
})
