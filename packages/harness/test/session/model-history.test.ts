import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { Asset } from "../../src/asset/asset"
import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { SessionMessageCache } from "../../src/session/message-cache"
import { modelWorkingSetForPrompt } from "../../src/session/model-working-set"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionInbox } from "../../src/session/inbox"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function writeUser(sessionID: string, text: string): Promise<MessageV2.User> {
  const info = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: PrimaryAgentIdentity.names.general,
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
  options: { summary?: boolean; rootID?: string; compaction?: MessageV2.Assistant["compaction"] } = {},
): Promise<MessageV2.Assistant> {
  const id = Identifier.ascending("message")
  const created = Date.now()
  const info = (await Session.updateMessage({
    id,
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
    time: { created, completed: created },
    finish: "stop",
    summary: options.summary || undefined,
    ...(options.summary ? { compaction: options.compaction ?? { coveredThrough: { created, messageID: id } } } : {}),
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

async function modelMessages(input: { sessionID: string; onLoadParts?: (messageID: string) => void }) {
  const history = SessionHistory as typeof SessionHistory & {
    modelMessages: (input: {
      sessionID: string
      onLoadParts?: (messageID: string) => void
    }) => Promise<MessageV2.WithParts[]>
  }
  const result = await history.modelMessages(input)
  expect(await SessionHistory.modelMessageInfos(input)).toEqual(result.map((message) => message.info))
  const raw = await MessageV2.filterCompacted(MessageV2.stream(input))
  expect(await SessionHistory.modelMessageInfos({ sessionID: input.sessionID, raw: true })).toEqual(
    raw.map((message) => message.info),
  )
  return result
}

describe("SessionHistory.modelMessages", () => {
  for (const kind of ["attachment", "tool"] as const) {
    test(`keeps cached ${kind} presentation defaults equal to reloaded history`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({})
            SessionMessageCache.enable(session.id)
            try {
              await SessionHistory.modelMessages({ sessionID: session.id })
              const root = await writeUser(session.id, "Inspect this image")
              const asset = await Asset.write(Buffer.from("retained image bytes"), "image/png", "fixture.png")
              const attachment: MessageV2.AttachmentPart = {
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: root.id,
                type: "attachment",
                mime: "image/png",
                url: `asset://${asset}`,
                presentation: kind === "tool" ? { renderer: "image", size: "small" } : undefined,
              }
              await Session.updatePart(
                kind === "attachment"
                  ? attachment
                  : {
                      id: Identifier.ascending("part"),
                      sessionID: session.id,
                      messageID: root.id,
                      type: "tool",
                      tool: "view_image",
                      callID: "fixture_call",
                      state: {
                        status: "completed",
                        input: {},
                        output: "An image",
                        title: "Image",
                        metadata: {},
                        time: { start: 1, end: 2 },
                        attachments: [
                          attachment,
                          { ...attachment, id: Identifier.ascending("part"), presentation: { purpose: "evidence" } },
                        ],
                      },
                    },
              )
              await writeUser(session.id, "Continue the next task")
              const hot = await SessionHistory.modelMessages({ sessionID: session.id })
              const cold = await SessionHistory.detachedModelMessages({ sessionID: session.id })
              expect(JSON.parse(JSON.stringify(hot))).toEqual(JSON.parse(JSON.stringify(cold)))
              const attachments = cold
                .flatMap((message) => message.parts)
                .flatMap((part) =>
                  part.type === "attachment"
                    ? [part]
                    : part.type === "tool" && part.state.status === "completed"
                      ? (part.state.attachments ?? [])
                      : [],
                )
              expect(attachments.map((part) => part.presentation?.purpose)).toEqual(
                kind === "tool" ? ["deliverable", "evidence"] : ["deliverable"],
              )
              SessionMessageCache.invalidate(session.id)
              expect(await SessionHistory.modelMessages({ sessionID: session.id })).toEqual(cold)
              expect(attachment.presentation).toEqual(
                kind === "tool" ? { renderer: "image", size: "small" } : undefined,
              )
              expect(await (await Asset.read(asset))?.text()).toBe("retained image bytes")
            } finally {
              SessionMessageCache.disable(session.id)
            }
          },
        })
      }))
  }

  test("keeps partial-compaction tails across cache eviction and fork while ordering only the model prompt", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const root = await writeUser(session.id, "current task")
          const covered = await writeAssistant(session.id, root.id, "earlier facts")
          const tail = await writeUser(session.id, "unprocessed constraint")
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: root.id,
            sessionID: session.id,
            type: "compaction",
            auto: true,
          })
          SessionMessageCache.enable(session.id)
          try {
            await SessionHistory.modelMessages({ sessionID: session.id })
            const summary = await writeAssistant(session.id, root.id, "summary of earlier facts", {
              summary: true,
              compaction: { coveredThrough: { created: covered.time.created, messageID: covered.id } },
            })
            await Session.mergeMessageMetadata({
              sessionID: session.id,
              messageID: summary.id,
              metadata: {
                remoteCompaction: {
                  version: 3,
                  provider: "openai-responses-compaction",
                  implementation: "responses_compaction_v2",
                  providerID: "test-provider",
                  modelID: "test-model",
                  modelKey: "test-provider/test-model",
                  coveredThrough: summary.compaction!.coveredThrough,
                  summaryText: "summary of earlier facts",
                  replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
                },
              },
            })
            const hot = await modelMessages({ sessionID: session.id })
            expect(hot.map((message) => message.info.id)).toEqual([root.id, tail.id, summary.id])
            const prompt = await MessageV2.projectModelMessages(modelWorkingSetForPrompt(hot))
            expect(prompt.messageSources).toEqual([root.id, summary.id, tail.id])
            const fullHistory = await MessageV2.projectModelMessages(await Session.messages({ sessionID: session.id }))
            expect(fullHistory.messageSources).toContain(covered.id)
            SessionMessageCache.invalidate(session.id)
            const loaded: string[] = []
            expect(await modelMessages({ sessionID: session.id, onLoadParts: (id) => loaded.push(id) })).toEqual(hot)
            expect(loaded).not.toContain(covered.id)
            const fork = await Session.fork({ sessionID: session.id })
            const copied = await Session.messages({ sessionID: fork.id })
            const copiedCovered = copied.find((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "earlier facts"),
            )!
            const copiedSummary = copied.find((message) => message.info.role === "assistant" && message.info.summary)!
            expect(
              copiedSummary.info.role === "assistant" && copiedSummary.info.compaction?.coveredThrough.messageID,
            ).toBe(copiedCovered.info.id)
            expect(copiedSummary.info.metadata?.remoteCompaction.coveredThrough.messageID).toBe(copiedCovered.info.id)
            const forkWorkingSet = await modelMessages({ sessionID: fork.id })
            expect(forkWorkingSet.some((message) => message.info.id === copiedCovered.info.id)).toBe(false)
            expect(
              forkWorkingSet.some((message) =>
                message.parts.some((part) => part.type === "text" && part.text === "unprocessed constraint"),
              ),
            ).toBe(true)
          } finally {
            SessionMessageCache.disable(session.id)
          }
        },
      })
    }))

  test("reloads an explicit partial boundary after reopening the runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    let sessionID = ""
    let expected: string[] = []
    const first = await testRuntime({ home: tmp.path })
    try {
      await first.run(async () =>
        ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({})
            sessionID = session.id
            const root = await writeUser(session.id, "task")
            const covered = await writeAssistant(session.id, root.id, "covered")
            const tail = await writeUser(session.id, "retained after restart")
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: root.id,
              sessionID: session.id,
              type: "compaction",
              auto: true,
            })
            const summary = await writeAssistant(session.id, root.id, "summary", {
              summary: true,
              compaction: { coveredThrough: { created: covered.time.created, messageID: covered.id } },
            })
            expected = [root.id, tail.id, summary.id]
          },
        }),
      )
    } finally {
      await first.close()
    }
    await using second = await testRuntime({ home: tmp.path })
    await second.run(async () =>
      ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          expect((await modelMessages({ sessionID })).map((message) => message.info.id)).toEqual(expected)
        },
      }),
    )
  })

  test("loads only the effective compacted working-set parts", () =>
    runtime.run(async () => {
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
    }))

  test("applies rollback events before choosing the compaction boundary", () =>
    runtime.run(async () => {
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
    }))

  test("keeps legacy non-root injections hidden while rollback remains active", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const root = await writeUser(session.id, "root")
          root.isRoot = true
          root.rootID = root.id
          await Session.updateMessage(root)
          await writeAssistant(session.id, root.id, "reply", { rootID: root.id })

          const rollback = (await Session.rollback({
            sessionID: session.id,
            numTurns: 1,
          })) as SessionHistory.RollbackEvent
          const legacySteer = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            agent: PrimaryAgentIdentity.names.general,
            model: { providerID: "test-provider", modelID: "test-model" },
            metadata: { noReply: true },
            time: { created: rollback.time.created + 1 },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: legacySteer.id,
            sessionID: session.id,
            type: "text",
            text: "legacy steer",
          })

          const full = await Session.messages({ sessionID: session.id })
          const model = await modelMessages({ sessionID: session.id })
          expect(model.map((message) => message.info.id)).toEqual(full.map((message) => message.info.id))
          expect(model.some((message) => message.info.id === legacySteer.id)).toBe(false)
        },
      })
    }))

  test("preserves chronological ordering for legacy stable message IDs", () =>
    runtime.run(async () => {
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
            agent: PrimaryAgentIdentity.names.general,
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
    }))
  test("keeps a delayed current-format inbox root after a compaction summary", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const delayedRootID = Identifier.ascending("message")
          const root = await writeUser(session.id, "root")
          root.isRoot = true
          root.rootID = root.id
          root.time.created = 100
          await Session.updateMessage(root)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: root.id,
            sessionID: session.id,
            type: "compaction",
            auto: true,
          })

          const summary = await writeAssistant(session.id, root.id, "summary", { summary: true, rootID: root.id })
          summary.time = { created: 200, completed: 200 }
          summary.compaction = { coveredThrough: { created: 200, messageID: summary.id } }
          await Session.updateMessage(summary)

          const delayedRoot = await Session.updateMessage({
            id: delayedRootID,
            role: "user",
            sessionID: session.id,
            agent: PrimaryAgentIdentity.names.general,
            model: { providerID: "test-provider", modelID: "test-model" },
            isRoot: true,
            rootID: delayedRootID,
            time: { created: 300 },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: delayedRoot.id,
            sessionID: session.id,
            type: "text",
            text: "delayed inbox task",
          })

          const full = await Session.messages({ sessionID: session.id })
          const model = await modelMessages({ sessionID: session.id })

          expect(full.map((message) => message.info.id)).toEqual([root.id, summary.id, delayedRootID])
          expect(model.map((message) => message.info.id)).toEqual([root.id, summary.id, delayedRootID])
          expect(await SessionInbox.latestRootID(session.id)).toBe(delayedRootID)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
