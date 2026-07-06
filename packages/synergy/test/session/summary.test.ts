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

const originalDiffSummary = Snapshot.diffSummary
const originalGetModel = Provider.getModel

afterEach(() => {
  ;(Snapshot.diffSummary as any) = originalDiffSummary
  ;(Provider.getModel as any) = originalGetModel
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
})
