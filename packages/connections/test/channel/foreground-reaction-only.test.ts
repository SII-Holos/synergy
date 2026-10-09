import { expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ProviderSdkSource } from "@ericsanchezok/synergy-harness/provider/sdk-source"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Channel } from "../../src/channel"
import type { ChannelHost } from "../../src/channel/host"
import type { Provider, StreamingSession } from "../../src/channel/types"
import { ChannelReactionOnlyTool } from "../../src/channel/tools/channel-reaction-only"
import { testRuntime } from "../support/runtime"

type FixtureSdk = ReturnType<ProviderSdkSource.Factory>
type FixtureModel = Extract<ReturnType<FixtureSdk["languageModel"]>, { specificationVersion: "v2" }>
type StreamResult = Awaited<ReturnType<FixtureModel["doStream"]>>
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never

const ACCOUNT_ID = "foreground_drain_account"
const FOREGROUND_INBOUND = "om_foreground_inbound"
const FOREGROUND_TOPIC = "om_foreground_topic"
const QUEUED_INBOUND = "om_queued_inbound"
const QUEUED_TOPIC = "om_queued_topic"
const FOREGROUND_TEXT = "Foreground text must remain private."
const QUEUED_TEXT = "Queued answer belongs only to B."
const ORDINARY_ANSWER = "answer42"
type Scenario = "queued-answer" | "queued-error" | "same-root-steer" | "ordinary-no-answer"
type ReactionTransport = "acknowledged" | "applied-then-timeout"

function stream(chunks: StreamPart[]): StreamResult {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  }
}

function textChunks(text: string): StreamPart[] {
  return [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: text },
    { type: "text-end", id: "answer" },
  ]
}

function finish(finishReason: "stop" | "tool-calls" | "length" = "stop"): Extract<StreamPart, { type: "finish" }> {
  return { type: "finish", finishReason, usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 } }
}

function reactionChunks(): StreamPart[] {
  return [
    ...textChunks(FOREGROUND_TEXT),
    {
      type: "tool-call",
      toolCallId: "artifact_a",
      toolName: "fixture_artifact",
      input: JSON.stringify({ owner: "A", workBrief: "Prepare the foreground artifact" }),
    },
    {
      type: "tool-call",
      toolCallId: "reaction_a",
      toolName: "channel_reaction_only",
      input: JSON.stringify({ workBrief: "Acknowledge without posting a reply" }),
    },
    finish(),
  ]
}

function inbound(messageId: string, replyToMessageId: string, text: string): ChannelHost.ConversationMessage {
  return {
    chatId: "foreground_drain_chat",
    chatType: "group",
    senderId: "foreground_drain_requester",
    scopeKey: "shared_thread",
    messageId,
    replyToMessageId,
    text,
    timestamp: 1_800_000_000_000,
  }
}

async function runScenario(
  scenario: Scenario,
  reactionTransport: ReactionTransport = "acknowledged",
  compensationFails = false,
  enumerationFails = false,
) {
  const connected = Promise.withResolvers<ChannelHost.Instance>()
  const modelStarted = Promise.withResolvers<void>()
  const releaseForeground = Promise.withResolvers<void>()
  const replies: Array<Parameters<NonNullable<Provider["replyMessage"]>>[0]> = []
  const pushes: Array<Parameters<NonNullable<Provider["pushMessage"]>>[0]> = []
  const reactions: Array<Parameters<NonNullable<Provider["addReaction"]>>[0]> = []
  const appliedReactions: Array<Parameters<NonNullable<Provider["addReaction"]>>[0]> = []
  const closes: Array<{ replyToMessageId?: string; finalText?: string; error?: boolean }> = []
  const updates: string[] = []
  const toolProgressUpdates: Array<Parameters<StreamingSession["updateToolProgress"]>[0]> = []
  const artifacts = new Map<string, string>()
  let primaryCalls = 0
  let failHistoryRead = false
  let historyFailures = 0

  const sdk: FixtureSdk = {
    languageModel(modelId): FixtureModel {
      return {
        specificationVersion: "v2",
        provider: "foreground-fixture",
        modelId,
        supportedUrls: {},
        async doGenerate() {
          throw new Error("Unexpected non-streaming fixture call")
        },
        async doStream() {
          if (modelId === "auxiliary") return stream([...textChunks("Fixture title."), finish()])
          if (modelId !== "primary") throw new Error(`Unexpected fixture model: ${modelId}`)
          const call = ++primaryCalls
          if (call === 1) {
            modelStarted.resolve()
            await releaseForeground.promise
            if (scenario === "same-root-steer") return stream([...textChunks(ORDINARY_ANSWER), finish()])
            if (scenario === "ordinary-no-answer")
              return stream([
                ...textChunks(ORDINARY_ANSWER),
                {
                  type: "tool-call",
                  toolCallId: "artifact_a",
                  toolName: "fixture_artifact",
                  input: JSON.stringify({ owner: "A" }),
                },
                finish("tool-calls"),
              ])
            // Even a model that emits text and an artifact with its terminal
            // intent must leave the reaction as A's exclusive delivery.
            return stream(reactionChunks())
          }
          if (call === 2 && scenario === "queued-error") throw new Error("Queued model failure")
          if (call === 2 && scenario === "same-root-steer") return stream(reactionChunks())
          if (call === 2 && scenario === "ordinary-no-answer") return stream([finish("length")])
          if (call === 2)
            return stream([
              ...textChunks(QUEUED_TEXT),
              {
                type: "tool-call",
                toolCallId: "artifact_b",
                toolName: "fixture_artifact",
                input: JSON.stringify({ owner: "B", workBrief: "Prepare the queued artifact" }),
              },
              finish(),
            ])
          throw new Error("Unexpected extra primary model turn")
        },
      }
    },
    textEmbeddingModel() {
      throw new Error("Unexpected embedding fixture call")
    },
    imageModel() {
      throw new Error("Unexpected image fixture call")
    },
  }
  const model = {
    name: "Fixture",
    release_date: "2026-10-01",
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    limit: { context: 128000, output: 8000 },
    options: {},
  }
  await using runtime = await testRuntime({
    env: {
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        model: "foreground-fixture/primary",
        nano_model: "foreground-fixture/auxiliary",
        mini_model: "foreground-fixture/auxiliary",
        provider: {
          "foreground-fixture": {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "synthetic-fixture-key", baseURL: "https://fixture.invalid/v1" },
            models: { primary: { ...model, id: "primary" }, auxiliary: { ...model, id: "auxiliary" } },
          },
        },
        agent: { fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Complete the fixture task." } },
        channel: {
          feishu: {
            type: "feishu",
            accounts: {
              [ACCOUNT_ID]: {
                appId: "synthetic-app",
                appSecret: "synthetic-secret",
                streaming: false,
                model: "foreground-fixture/primary",
                reactionOnlyReply: { enabled: true, forceReaction: "SILENT" },
              },
            },
          },
        },
      }),
    },
    register() {
      ProviderSdkSource.register(undefined)
      ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
      const artifact = Tool.define(
        "fixture_artifact",
        {
          description: "Create a synthetic deliverable for this task.",
          parameters: z.object({ owner: z.enum(["A", "B"]) }),
          async execute({ owner }, context) {
            const filename = `artifact-${owner}.txt`
            const assetID = await Asset.write(Buffer.from(`Artifact belonging to ${owner}`), "text/plain", filename)
            artifacts.set(owner, assetID)
            return {
              title: filename,
              output: `Prepared ${filename}`,
              metadata: {},
              attachments: [
                {
                  id: Identifier.ascending("part"),
                  messageID: context.messageID,
                  sessionID: context.sessionID,
                  type: "attachment" as const,
                  mime: "text/plain",
                  filename,
                  url: `asset://${assetID}`,
                  model: { mode: "none" as const },
                  presentation: { purpose: "deliverable" as const },
                },
              ],
            }
          },
        },
        { requiresWorkspace: false, exposure: { mode: "resident" } },
      )
      ToolRegistry.registerToolProvider("foreground-fixture", () => [artifact, ChannelReactionOnlyTool])
    },
  })

  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const provider: Provider = {
          type: "feishu",
          lifecycle: "self_connected",
          defaultAgent: "fixture",
          async connect({ host }) {
            connected.resolve(host)
          },
          async replyMessage(input) {
            replies.push(input)
            if (compensationFails && replies.length === 1) throw new Error("First ordinary delivery failed")
            return { messageId: `fixture_reply_${replies.length}` }
          },
          async pushMessage(input) {
            pushes.push(input)
            return { messageId: `fixture_push_${pushes.length}` }
          },
          async addReaction(input) {
            reactions.push(input)
            if (input.emoji === "SILENT") {
              appliedReactions.push({ ...input })
              // The remote side effect happened; only its acknowledgement was
              // lost. This is not a business rejection before application.
              if (reactionTransport === "applied-then-timeout")
                throw new DOMException("Reaction applied but acknowledgement timed out", "TimeoutError")
            }
            return { reactionId: `fixture_reaction_${reactions.length}` }
          },
          async removeReaction() {},
          createStreamingSession(input) {
            return {
              async start() {},
              async update(text) {
                updates.push(text)
              },
              async updateToolProgress(progress) {
                toolProgressUpdates.push(progress.map((item) => ({ ...item })))
              },
              async close(finalText, error) {
                closes.push({ replyToMessageId: input.replyToMessageId, finalText, error })
                if (finalText)
                  await provider.replyMessage!({
                    accountId: input.accountId,
                    messageId: input.replyToMessageId!,
                    parts: [{ type: "text", text: finalText }],
                  })
              },
              isActive: () => false,
              ownsTerminalDelivery: () => true,
            }
          },
        }
        Channel.registerProvider(provider)
        const realInvoke = SessionInvoke.invokeInboxWithLease
        const returned: Awaited<ReturnType<typeof realInvoke>>[] = []
        const invokeErrors: unknown[] = []
        let sessionID = ""
        let steerMessageID: string | undefined
        let steerFailure: unknown
        let unsubscribeSteer: (() => void) | undefined
        const realMessages = Session.messages
        const history = spyOn(Session, "messages").mockImplementation(
          Object.assign(
            async (input: Parameters<typeof realMessages>[0]) => {
              if (failHistoryRead && input.sessionID === sessionID) {
                failHistoryRead = false
                historyFailures += 1
                throw new Error("Post-invoke history read failed")
              }
              return realMessages(input)
            },
            { force: realMessages.force, schema: realMessages.schema },
          ),
        )
        // Observe the public return without replacing lease admission, inbox
        // materialization, generation, tools, terminal settlement or drain.
        const invoke = spyOn(SessionInvoke, "invokeInboxWithLease").mockImplementation(async (input, lease) => {
          sessionID = input.sessionID
          try {
            const result = await realInvoke(input, lease)
            returned.push(result)
            failHistoryRead = enumerationFails
            return result
          } catch (error) {
            invokeErrors.push(error)
            throw error
          }
        })
        let foreground: ChannelHost.ReceiveResult | undefined
        try {
          await Channel.init()
          const host = await connected.promise
          if (scenario === "same-root-steer") {
            let injected = false
            unsubscribeSteer = Bus.subscribe(MessageV2.Event.Updated, async (event) => {
              const info = event.properties.info
              if (
                injected ||
                info.sessionID !== sessionID ||
                info.role !== "assistant" ||
                info.finish !== "stop" ||
                !info.time.completed
              )
                return
              injected = true
              try {
                const delivery = await SessionInbox.deliver({
                  sessionID,
                  mode: "steer",
                  message: {
                    role: "user",
                    parts: [{ type: "text", text: "Acknowledge this continuation without another answer." }],
                    visible: true,
                    metadata: { fixtureSameRootSteer: true },
                  },
                })
                steerMessageID = delivery.messageID
              } catch (error) {
                steerFailure = error
              }
            })
          }
          foreground = await host.conversations.receive(inbound(FOREGROUND_INBOUND, FOREGROUND_TOPIC, "Acknowledge A."))
          expect(foreground.accepted).toBe(true)
          if (!foreground.accepted) throw new Error("Expected foreground acceptance")
          await modelStarted.promise
          if (scenario !== "same-root-steer" && scenario !== "ordinary-no-answer") {
            const queued = await host.conversations.receive(inbound(QUEUED_INBOUND, QUEUED_TOPIC, "Answer B."))
            expect(queued.accepted).toBe(true)
            if (!queued.accepted) throw new Error("Expected queued acceptance")
            await queued.execution
            const pending = await SessionInbox.list(sessionID)
            expect(pending).toHaveLength(1)
            expect(pending[0].message?.metadata?.channelInboundMessageId).toBe(QUEUED_INBOUND)
          }
          expect(primaryCalls).toBe(1)

          releaseForeground.resolve()
          await foreground.execution
          expect(invoke).toHaveBeenCalledTimes(1)
          expect(primaryCalls).toBe(2)
          expect(await SessionInbox.list(sessionID)).toEqual([])
          const messages = await Session.messages({ sessionID })
          const rootA = messages.find(
            (message) =>
              message.info.metadata?.channelInboundMessageId === FOREGROUND_INBOUND && message.info.role === "user",
          )!
          expect(rootA).toBeDefined()
          if (enumerationFails) {
            expect(historyFailures).toBe(1)
            expect(returned).toHaveLength(1)
            expect(
              messages.some((message) =>
                message.parts.some((part) => part.type === "tool" && part.tool === "channel_reaction_only"),
              ),
            ).toBe(true)
            expect(replies).toEqual([])
            expect(pushes).toEqual([])
            expect(closes).toEqual([])
            expect(reactions.filter((reaction) => reaction.emoji !== "Typing")).toEqual([])
            return
          }
          if (scenario === "ordinary-no-answer") {
            const assistants = messages.filter((message) => message.info.role === "assistant")
            expect(assistants).toHaveLength(2)
            if (assistants[0].info.role !== "assistant" || assistants[1].info.role !== "assistant")
              throw new Error("Expected ordinary generation steps")
            expect(assistants[0].info.finish).toBe("tool-calls")
            expect(assistants[1].info.finish).toBe("length")
            expect(assistants[1].parts.filter((part) => part.type === "text")).toEqual([])
            expect(closes).toEqual([{ replyToMessageId: FOREGROUND_TOPIC, finalText: ORDINARY_ANSWER, error: false }])
            expect(replies[0].parts).toEqual([{ type: "text", text: ORDINARY_ANSWER }])
            expect(replies[1].parts).toEqual([
              {
                type: "file",
                path: Asset.resolvePath(artifacts.get("A")!),
                filename: "artifact-A.txt",
                contentType: "text/plain",
              },
            ])
            expect(reactions.filter((reaction) => reaction.emoji === "SILENT" || reaction.emoji === "ERROR")).toEqual(
              [],
            )
            return
          }
          if (scenario === "same-root-steer") {
            expect(steerFailure).toBeUndefined()
            expect(steerMessageID).toBeDefined()
            const steer = messages.find((message) => message.info.id === steerMessageID)!
            expect(steer.info).toMatchObject({ role: "user", isRoot: false, rootID: rootA.info.id })
            const terminals = messages.filter(
              (message) =>
                message.info.role === "assistant" &&
                message.info.rootID === rootA.info.id &&
                message.info.finish === "stop",
            )
            expect(terminals).toHaveLength(2)
            const ordinary = terminals.find((message) =>
              message.parts.some((part) => part.type === "text" && part.text === ORDINARY_ANSWER),
            )!
            const reaction = terminals.find((message) => message.info.id !== ordinary.info.id)!
            expect(returned[0].info.id).toBe(reaction.info.id)
            expect(invokeErrors).toEqual([])
            expect(reaction.parts).toContainEqual(
              expect.objectContaining({
                type: "tool",
                tool: "channel_reaction_only",
                state: expect.objectContaining({
                  status: "completed",
                  metadata: expect.objectContaining({ intent: { type: "reaction_only", reaction: "SILENT" } }),
                }),
              }),
            )
            expect(artifacts.get("A")).toBeDefined()
            expect(replies).toEqual([
              expect.objectContaining({
                accountId: ACCOUNT_ID,
                messageId: FOREGROUND_TOPIC,
                parts: [{ type: "text", text: ORDINARY_ANSWER }],
              }),
            ])
            expect(closes.every((close) => close.finalText === undefined || close.finalText === ORDINARY_ANSWER)).toBe(
              true,
            )
            expect(reactions.filter((value) => value.emoji === "SILENT")).toEqual([
              { accountId: ACCOUNT_ID, messageId: FOREGROUND_INBOUND, emoji: "SILENT" },
            ])
            const persistedOrdinary = await MessageV2.get({ sessionID, messageID: ordinary.info.id })
            const persistedReaction = await MessageV2.get({ sessionID, messageID: reaction.info.id })
            expect(persistedOrdinary.info.metadata?.channelOutboundSent).toBe(compensationFails ? undefined : true)
            expect(persistedOrdinary.info.metadata?.channelReactionOnlyDelivered).toBeUndefined()
            expect(persistedReaction.info.metadata?.channelOutboundSent).toBe(true)
            expect(persistedReaction.info.metadata?.channelReactionOnlyDelivered).toBe("SILENT")
            expect(rootA.info.metadata?.channelOutboundAttachmentUrls).toBeUndefined()
            await Promise.all(
              [ordinary, reaction, ordinary, reaction].map((terminal) =>
                Bus.publish(MessageV2.Event.Updated, { info: terminal.info }),
              ),
            )
            expect(replies).toHaveLength(compensationFails ? 2 : 1)
            expect(
              replies.every((reply) =>
                reply.parts.every((part) => part.type !== "text" || part.text === ORDINARY_ANSWER),
              ),
            ).toBe(true)
            expect(reactions.filter((value) => value.emoji === "SILENT")).toHaveLength(1)
            expect(pushes).toEqual([])
            return
          }
          const rootB = messages.find(
            (message) =>
              message.info.metadata?.channelInboundMessageId === QUEUED_INBOUND && message.info.role === "user",
          )!
          expect(rootA).toBeDefined()
          expect(rootB).toBeDefined()
          expect(rootA.info).toMatchObject({ isRoot: true, rootID: rootA.info.id })
          expect(rootB.info).toMatchObject({ isRoot: true, rootID: rootB.info.id })
          if (scenario === "queued-error") {
            expect(returned).toEqual([])
            expect(invokeErrors).toHaveLength(1)
            expect(invokeErrors[0]).toBeInstanceOf(MessageV2.SessionTerminalError)
            const terminalA = messages.find(
              (message) =>
                message.info.role === "assistant" &&
                message.info.rootID === rootA.info.id &&
                message.info.finish === "stop",
            )!
            const failedB = messages.find(
              (message) =>
                message.info.role === "assistant" &&
                message.info.rootID === rootB.info.id &&
                message.info.finish === "error",
            )!
            expect(terminalA).toBeDefined()
            expect(failedB).toBeDefined()
            if (terminalA.info.role !== "assistant" || failedB.info.role !== "assistant")
              throw new Error("Expected assistant terminals")
            expect(terminalA.info.error).toBeUndefined()
            expect(failedB.info.error).toBeDefined()
            expect(terminalA.parts).toContainEqual(expect.objectContaining({ type: "text", text: FOREGROUND_TEXT }))
            expect(terminalA.parts).toContainEqual(
              expect.objectContaining({
                type: "tool",
                tool: "channel_reaction_only",
                state: expect.objectContaining({
                  status: "completed",
                  metadata: expect.objectContaining({ intent: { type: "reaction_only", reaction: "SILENT" } }),
                }),
              }),
            )
            expect(artifacts.get("A")).toBeDefined()
            expect(closes).toEqual([{ replyToMessageId: FOREGROUND_TOPIC, finalText: undefined, error: false }])
            expect(replies).toEqual([])
            expect(pushes).toEqual([])
            expect(
              reactions.filter((value) => value.messageId === FOREGROUND_INBOUND && value.emoji !== "Typing"),
            ).toEqual([{ accountId: ACCOUNT_ID, messageId: FOREGROUND_INBOUND, emoji: "SILENT" }])
            const persistedA = await MessageV2.get({ sessionID, messageID: terminalA.info.id })
            expect(persistedA.info.metadata?.channelReactionOnlyDelivered).toBe("SILENT")
            expect(persistedA.info.metadata?.channelOutboundSent).toBe(true)
            expect(failedB.info.metadata?.channelReactionOnlyDelivered).toBeUndefined()
            expect(failedB.info.metadata?.channelReactionOnlyAttempted).toBeUndefined()
            expect(rootA.info.metadata?.channelOutboundAttachmentUrls).toBeUndefined()
            await Promise.all(
              [terminalA, terminalA].map((terminal) => Bus.publish(MessageV2.Event.Updated, { info: terminal.info })),
            )
            expect(replies).toEqual([])
            expect(
              reactions.filter((value) => value.messageId === FOREGROUND_INBOUND && value.emoji === "SILENT"),
            ).toHaveLength(1)
            return
          }
          const terminalA = messages.find(
            (message) =>
              message.info.role === "assistant" &&
              message.info.rootID === rootA.info.id &&
              message.info.finish === "stop",
          )!
          const terminalB = messages.find(
            (message) =>
              message.info.role === "assistant" &&
              message.info.rootID === rootB.info.id &&
              message.info.finish === "stop",
          )!
          expect(terminalA).toBeDefined()
          expect(terminalB).toBeDefined()
          if (terminalA.info.role !== "assistant" || terminalB.info.role !== "assistant")
            throw new Error("Expected both task terminals to be assistant messages")
          expect(terminalA.info.error).toBeUndefined()
          expect(terminalB.info.error).toBeUndefined()
          expect(returned[0].info.id).toBe(terminalB.info.id)
          expect(terminalA.parts).toContainEqual(expect.objectContaining({ type: "text", text: FOREGROUND_TEXT }))
          expect(terminalA.parts).toContainEqual(
            expect.objectContaining({
              type: "tool",
              tool: "channel_reaction_only",
              state: expect.objectContaining({
                status: "completed",
                metadata: expect.objectContaining({ intent: { type: "reaction_only", reaction: "SILENT" } }),
              }),
            }),
          )
          expect(artifacts.size).toBe(2)
          for (const [owner, terminal] of [
            ["A", terminalA],
            ["B", terminalB],
          ] as const) {
            expect(terminal.parts).toContainEqual(
              expect.objectContaining({
                type: "tool",
                tool: "fixture_artifact",
                state: expect.objectContaining({
                  status: "completed",
                  attachments: [
                    expect.objectContaining({
                      type: "attachment",
                      url: `asset://${artifacts.get(owner)}`,
                      filename: `artifact-${owner}.txt`,
                    }),
                  ],
                }),
              }),
            )
          }
          expect(updates).toContain(FOREGROUND_TEXT)
          expect(updates.every((text) => !text.includes(QUEUED_TEXT))).toBe(true)
          const foregroundToolIDs = terminalA.parts.filter((part) => part.type === "tool").map((part) => part.id)
          const queuedToolIDs = terminalB.parts.filter((part) => part.type === "tool").map((part) => part.id)
          const progressIDs = toolProgressUpdates.flat().map((item) => item.id)
          expect(progressIDs.length).toBeGreaterThan(0)
          expect(progressIDs.every((id) => foregroundToolIDs.includes(id))).toBe(true)
          for (const id of queuedToolIDs) expect(progressIDs).not.toContain(id)
          expect(closes).toEqual([{ replyToMessageId: FOREGROUND_TOPIC, finalText: undefined, error: false }])
          expect(reactions.filter((reaction) => reaction.emoji !== "Typing")).toEqual([
            { accountId: ACCOUNT_ID, messageId: FOREGROUND_INBOUND, emoji: "SILENT" },
          ])
          expect(replies).toHaveLength(1)
          expect(replies[0]).toMatchObject({
            accountId: ACCOUNT_ID,
            messageId: QUEUED_TOPIC,
          })
          expect(replies[0].parts).toEqual([
            { type: "text", text: QUEUED_TEXT },
            {
              type: "file",
              path: Asset.resolvePath(artifacts.get("B")!),
              filename: "artifact-B.txt",
              contentType: "text/plain",
            },
          ])
          expect(pushes).toEqual([])
          if (reactionTransport === "applied-then-timeout") {
            expect(appliedReactions).toEqual([
              { accountId: ACCOUNT_ID, messageId: FOREGROUND_INBOUND, emoji: "SILENT" },
            ])
            expect(reactions.some((reaction) => reaction.emoji === "ERROR")).toBe(false)
            const persistedA = await MessageV2.get({ sessionID, messageID: terminalA.info.id })
            expect(persistedA.info.metadata?.channelReactionOnlyAttempted).toBe("SILENT")
            expect(persistedA.info.metadata?.channelReactionOnlyDelivered).toBeUndefined()
            expect(persistedA.info.metadata?.channelReactionOnlyError).toBeUndefined()
            expect(persistedA.info.metadata?.channelOutboundSent).toBeUndefined()
            expect(terminalB.info.metadata?.channelReactionOnlyAttempted).toBeUndefined()
            expect(terminalB.info.metadata?.channelReactionOnlyDelivered).toBeUndefined()
            expect(terminalB.info.metadata?.channelOutboundSent).toBe(true)
            expect(rootA.info.metadata?.channelOutboundAttachmentUrls).toBeUndefined()
            expect(rootB.info.metadata?.channelOutboundAttachmentUrls).toEqual([`asset://${artifacts.get("B")}`])
            await Promise.all(
              [persistedA, terminalB, persistedA, terminalB].map((terminal) =>
                Bus.publish(MessageV2.Event.Updated, { info: terminal.info }),
              ),
            )
            expect(replies).toHaveLength(1)
            expect(appliedReactions).toHaveLength(1)
            expect(reactions.filter((reaction) => reaction.emoji === "SILENT")).toHaveLength(1)
            expect(reactions.some((reaction) => reaction.emoji === "ERROR")).toBe(false)
            const replayedA = await MessageV2.get({ sessionID, messageID: terminalA.info.id })
            expect(replayedA.info.metadata?.channelReactionOnlyAttempted).toBe("SILENT")
            expect(replayedA.info.metadata?.channelReactionOnlyDelivered).toBeUndefined()
            expect(replayedA.info.metadata?.channelReactionOnlyError).toBeUndefined()
            expect(replayedA.info.metadata?.channelOutboundSent).toBeUndefined()
            return
          }
          expect(terminalA.info.metadata?.channelReactionOnlyDelivered).toBe("SILENT")
          expect(terminalA.info.metadata?.channelOutboundSent).toBe(true)
          expect(terminalB.info.metadata?.channelReactionOnlyDelivered).toBeUndefined()
          expect(terminalB.info.metadata?.channelReactionOnlyAttempted).toBeUndefined()
          expect(terminalB.info.metadata?.channelOutboundSent).toBe(true)
          expect(rootA.info.metadata?.channelOutboundAttachmentUrls).toBeUndefined()
          expect(rootB.info.metadata?.channelOutboundAttachmentUrls).toEqual([`asset://${artifacts.get("B")}`])

          await Promise.all(
            [terminalA, terminalB, terminalA, terminalB].map((terminal) =>
              Bus.publish(MessageV2.Event.Updated, { info: terminal.info }),
            ),
          )
          expect(replies).toHaveLength(1)
          expect(reactions.filter((reaction) => reaction.emoji === "SILENT")).toHaveLength(1)
        } finally {
          releaseForeground.resolve()
          await foreground?.execution
          unsubscribeSteer?.()
          invoke.mockRestore()
          history.mockRestore()
          await Channel.stopAll()
        }
      },
    }),
  )
}

test(
  "foreground reaction-only stays on A when its real invoke drains queued B last",
  () => runScenario("queued-answer"),
  20_000,
)
test(
  "completed foreground reaction-only remains exclusive when queued B makes the real invoke reject",
  () => runScenario("queued-error"),
  20_000,
)
test(
  "same-root steer retains the ordinary terminal answer before a later reaction-only terminal",
  () => runScenario("same-root-steer"),
  20_000,
)

test(
  "foreground reaction applied remotely before timeout stays ambiguous without ERROR or replay",
  () => runScenario("queued-answer", "applied-then-timeout"),
  20_000,
)

test(
  "failed ordinary compensation never leaks the later reaction-only transcript",
  () => runScenario("same-root-steer", "acknowledged", true),
  30_000,
)

test(
  "foreground no-answer terminal preserves ordinary segment text before its tool step",
  () => runScenario("ordinary-no-answer"),
  30_000,
)

test(
  "post-invoke terminal history read failure never emits a private aggregate transcript",
  () => runScenario("same-root-steer", "acknowledged", false, true),
  30_000,
)
