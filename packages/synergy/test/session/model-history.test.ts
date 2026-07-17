import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

async function writeUser(sessionID: string, text: string): Promise<MessageV2.User> {
  const info = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })) as MessageV2.User
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text,
  })
  return info
}

async function writeAssistant(
  sessionID: string,
  parentID: string,
  text: string,
  options: { summary?: boolean; rootID?: string } = {},
): Promise<MessageV2.Assistant> {
  const info = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    parentID,
    rootID: options.rootID ?? parentID,
    modelID: "test-model",
    providerID: "test-provider",
    mode: options.summary ? "compaction" : "synergy",
    agent: options.summary ? "compaction" : "synergy",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
    summary: options.summary || undefined,
  })) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text,
    origin: options.summary ? "system" : undefined,
  })
  return info
}

function modelMessages(input: { sessionID: string; onLoadParts?: (messageID: string) => void }) {
  const history = SessionHistory as typeof SessionHistory & {
    modelMessages: (input: {
      sessionID: string
      onLoadParts?: (messageID: string) => void
    }) => Promise<MessageV2.WithParts[]>
  }
  return history.modelMessages(input)
}

describe("SessionHistory.modelMessages", () => {
  test("loads only the effective compacted working-set parts", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeUser(session.id, "root request")
        root.isRoot = true
        root.rootID = root.id
        await Session.updateMessage(root)

        const compactedMessageIDs: string[] = []
        for (let index = 0; index < 8; index++) {
          const user = await writeUser(session.id, `old user ${index} ${"x".repeat(10_000)}`)
          compactedMessageIDs.push(user.id)
          const assistant = await writeAssistant(session.id, user.id, `old assistant ${index} ${"y".repeat(10_000)}`)
          compactedMessageIDs.push(assistant.id)
        }

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: root.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })
        const firstSummary = await writeAssistant(session.id, root.id, "first summary", {
          summary: true,
          rootID: root.id,
        })
        await writeUser(session.id, "intermediate continuation")
        await writeAssistant(session.id, root.id, "intermediate reply", { rootID: root.id })
        const latestSummary = await writeAssistant(session.id, root.id, "latest summary", {
          summary: true,
          rootID: root.id,
        })
        const continuation = await writeUser(session.id, "latest continuation")
        continuation.isRoot = false
        continuation.rootID = root.id
        await Session.updateMessage(continuation)

        const loadedPartMessageIDs: string[] = []
        const model = await modelMessages({
          sessionID: session.id,
          onLoadParts: (messageID) => loadedPartMessageIDs.push(messageID),
        })

        expect(model.map((message) => message.info.id)).toEqual([
          root.id,
          firstSummary.id,
          latestSummary.id,
          continuation.id,
        ])
        expect(model.find((message) => message.info.id === firstSummary.id)?.info.includeInContext).toBe(false)
        expect(model.find((message) => message.info.id === latestSummary.id)?.info.includeInContext).not.toBe(false)
        expect(loadedPartMessageIDs.some((id) => compactedMessageIDs.includes(id))).toBe(false)
        expect(new Set(loadedPartMessageIDs)).toEqual(
          new Set([root.id, firstSummary.id, latestSummary.id, continuation.id]),
        )

        const full = await Session.messages({ sessionID: session.id })
        expect(full.length).toBeGreaterThan(model.length)
        expect(full.some((message) => compactedMessageIDs.includes(message.info.id))).toBe(true)
      },
    })
  })

  test("applies rollback events before choosing the compaction boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeUser(session.id, "root")
        root.isRoot = true
        root.rootID = root.id
        await Session.updateMessage(root)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: root.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })
        const summary = await writeAssistant(session.id, root.id, "summary", { summary: true, rootID: root.id })
        const post = await writeUser(session.id, "post-compaction task")
        post.isRoot = true
        post.rootID = post.id
        await Session.updateMessage(post)
        await writeAssistant(session.id, post.id, "post reply", { rootID: post.id })

        await Session.rollback({ sessionID: session.id, cutMessageID: post.id })

        const model = await modelMessages({ sessionID: session.id })
        expect(model.map((message) => message.info.id)).toEqual([root.id, summary.id])
      },
    })
  })

  test("preserves chronological ordering for legacy stable message IDs", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await writeUser(session.id, "root")
        root.isRoot = true
        root.rootID = root.id
        await Session.updateMessage(root)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: root.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })
        const summary = await writeAssistant(session.id, root.id, "summary", { summary: true, rootID: root.id })
        const legacyID = `msg_${"0".repeat(26)}`
        const legacy = await Session.updateMessage({
          id: legacyID,
          role: "user",
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test-provider", modelID: "test-model" },
          isRoot: false,
          rootID: root.id,
          time: { created: summary.time.created + 1 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: legacy.id,
          sessionID: session.id,
          type: "text",
          text: "legacy continuation",
        })

        const model = await modelMessages({ sessionID: session.id })
        expect(model.map((message) => message.info.id)).toEqual([root.id, summary.id, legacyID])
      },
    })
  })
})
