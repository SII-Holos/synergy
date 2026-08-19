import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { BusyError } from "../../src/session/error"
import { Attachment } from "../../src/attachment"
import { Asset } from "../../src/asset/asset"
import { ChannelBusyHandoff } from "../../src/channel/busy-handoff"
import { ChannelConversationAcceptance } from "../../src/channel/conversation-acceptance"
import { SessionEndpoint } from "../../src/session/endpoint"

const FEISHU_MESSAGE_ID = "om_message_12345678901234567890123456789012"
const FEISHU_REPLY_TO = "om_reply_abcdefghijklmnopqrstuvwxyz0123456789"
const CHANNEL_REQUESTER = "ou_channel_requester_user"

/**
 * The durable busy-handoff contract:
 * when a Feishu message arrives while its per-scope Session is busy, the
 * Channel core must enqueue exactly one inbox item keyed by the stable
 * account/message delivery key, preserving channel correlation metadata,
 * instead of failing the direct invoke.
 */
describe("Feishu busy durable handoff", () => {
  test("busy Session message is durably queued through the Channel handoff without a generation failure", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        // Occupy the session like an active generation loop does.
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()
        if (!lease) throw new Error("expected to acquire the session lease")

        try {
          // The Channel-owned seam is what the message handler exercises: a
          // BusyError raised by the direct invoke is converted into a durable
          // inbox task instead of a generation failure.
          const parts = await ChannelBusyHandoff.buildDurablePromptParts({
            ctx: {
              channelType: "feishu",
              accountId: "account_busy",
              chatId: "chat_busy",
              chatType: "dm",
              senderId: CHANNEL_REQUESTER,
              senderName: "Requester",
              text: "Can you help?",
              messageId: FEISHU_MESSAGE_ID,
              timestamp: Date.now(),
              replyToMessageId: FEISHU_REPLY_TO,
            },
            sessionID: session.id,
            messageID: "msg_channel_busy_000000000000000000000",
          })
          expect(parts).toHaveLength(1)
          expect(parts[0]).toMatchObject({ type: "text", text: "Can you help?" })

          const deliveryKey = ChannelBusyHandoff.deliveryKeyForMessage({
            channelType: "feishu",
            accountId: "account_busy",
            messageId: FEISHU_MESSAGE_ID,
          })
          expect(deliveryKey).toBe(`channel:feishu:account_busy:${FEISHU_MESSAGE_ID}`)

          // The direct invoke rejects with BusyError while the session is
          // leased; the handler then hands the same inputs to the inbox.
          await expect(
            SessionInvoke.invoke({
              sessionID: session.id,
              parts,
              metadata: {
                channelReplyToMessageId: FEISHU_REPLY_TO,
                channelRequesterId: CHANNEL_REQUESTER,
              },
            }),
          ).rejects.toBeInstanceOf(BusyError)

          const queued = await ChannelBusyHandoff.deliverBusyTaskToInbox({
            error: new BusyError(session.id),
            sessionID: session.id,
            deliveryKey,
            parts,
            metadata: {
              channelReply: true,
              channelReplyToMessageId: FEISHU_REPLY_TO,
              channelRequesterId: CHANNEL_REQUESTER,
            },
          })
          expect(queued.status).toBe("queued")
          if (queued.status !== "queued") throw new Error("expected queued handoff")

          // Exactly one durable task item with stable identity and correlation.
          const items = await SessionInbox.list(session.id)
          expect(items).toHaveLength(1)
          const item = items[0]
          expect(item.mode).toBe("task")
          expect(item.deliveryKey).toBe(deliveryKey)
          expect(item.id).toBe(queued.itemID)
          expect(item.messageID).toBe(queued.messageID)
          expect(item.message?.metadata).toMatchObject({
            channelReply: true,
            channelReplyToMessageId: FEISHU_REPLY_TO,
            channelRequesterId: CHANNEL_REQUESTER,
          })

          // The same remote message identity replays to the same item — the
          // handler must not fail the card or enqueue a second copy.
          const replay = await ChannelBusyHandoff.deliverBusyTaskToInbox({
            error: new BusyError(session.id),
            sessionID: session.id,
            deliveryKey,
            parts,
            metadata: {
              channelReply: true,
              channelReplyToMessageId: FEISHU_REPLY_TO,
              channelRequesterId: CHANNEL_REQUESTER,
            },
          })
          expect(replay.status).toBe("duplicate")
          if (replay.status !== "duplicate") throw new Error("expected duplicate handoff")
          expect(replay.itemID).toBe(queued.itemID)
          expect(await SessionInbox.list(session.id)).toHaveLength(1)
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
        }
      },
    })
  })

  test("deliverUnique enqueues exactly one task item with preserved correlation metadata and stable IDs", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const endpoint = SessionEndpoint.fromChannel({
          type: "feishu",
          accountId: "account_busy",
          chatId: "chat_busy",
          chatType: "dm",
          senderId: CHANNEL_REQUESTER,
          senderName: "Requester",
          scopeKey: undefined,
          createdAt: Date.now(),
        })
        const session = await Session.create({ endpoint })
        const deliveryKey = `feishu:account_busy:${FEISHU_MESSAGE_ID}`
        const deliver = () =>
          SessionInbox.deliverUnique({
            sessionID: session.id,
            deliveryKey,
            mode: "task",
            message: {
              role: "user",
              parts: [{ type: "text", text: "Can you help?" }],
              visible: true,
              origin: { type: "channel", label: "feishu" },
              metadata: {
                channelReply: true,
                channelReplyToMessageId: FEISHU_REPLY_TO,
                channelRequesterId: CHANNEL_REQUESTER,
              },
            },
          })

        const first = await deliver()
        expect(first.created).toBe(true)

        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)
        const item = items[0]
        expect(item.mode).toBe("task")
        expect(item.deliveryKey).toBe(deliveryKey)
        expect(item.id).toBe(first.itemID)
        expect(item.messageID).toBe(first.messageID)
        expect(item.message?.metadata).toMatchObject({
          channelReply: true,
          channelReplyToMessageId: FEISHU_REPLY_TO,
          channelRequesterId: CHANNEL_REQUESTER,
        })

        // Replaying the same Feishu message identity must not create a duplicate.
        const replay = await deliver()
        expect(replay.created).toBe(false)
        expect(replay.itemID).toBe(first.itemID)
        expect(replay.messageID).toBe(first.messageID)
        expect(await SessionInbox.list(session.id)).toHaveLength(1)
      },
    })
  })
})

/**
 * Attachment durability contract: prompt parts are produced from the temp
 * attachment file via Attachment.toPart (data URL for images, asset:// for
 * others) so the source file can be cleaned up before the inbox item is
 * materialized.
 */
describe("Feishu attachment durable prompt parts", () => {
  test("image attachment materializes after the source temp file is deleted", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const filepath = path.join(tmp.path, "inbound-image.png")
        await Bun.write(filepath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]))

        const part = await Attachment.toPart({
          filepath,
          mime: "image/png",
          filename: "inbound-image.png",
          sessionID: session.id,
          messageID: "msg_durable_image_000000000000000000000",
        })
        expect(part.url.startsWith("data:image/png;base64,")).toBe(true)
        expect(part.model?.mode).toBe("provider-file")

        await SessionInbox.deliverUnique({
          sessionID: session.id,
          deliveryKey: `feishu-attachment:${FEISHU_MESSAGE_ID}`,
          mode: "task",
          message: {
            role: "user",
            parts: [part],
            visible: true,
            origin: { type: "channel", label: "feishu" },
          },
        })

        // The temp source file is removed before materialization (mirrors the
        // finally-cleanup in the Channel message handler).
        await fs.unlink(filepath)
        await expect(fs.access(filepath)).rejects.toThrow()

        const items = await SessionInbox.list(session.id)
        const materialized = await SessionInbox.materializeItem(items[0])
        expect(materialized?.info.id).toBe(items[0].messageID)
        const attachmentPart = materialized?.parts.find((p) => p.type === "attachment")
        expect(attachmentPart?.type).toBe("attachment")
        if (attachmentPart?.type === "attachment") {
          expect(attachmentPart.url).toBe(part.url)
          expect(attachmentPart.mime).toBe("image/png")
          expect(attachmentPart.model?.mode).toBe("provider-file")
        }
      },
    })
  })

  test("image attachment prompt part persists a local path so look_at has a file to analyze", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const filepath = path.join(tmp.path, "inbound-image.png")
        await Bun.write(filepath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]))

        const parts = await ChannelBusyHandoff.buildDurablePromptParts({
          ctx: {
            channelType: "feishu",
            accountId: "account_busy",
            chatId: "chat_busy",
            chatType: "dm",
            senderId: CHANNEL_REQUESTER,
            senderName: "Requester",
            text: "look at this",
            messageId: FEISHU_MESSAGE_ID,
            timestamp: Date.now(),
            attachments: [{ path: filepath, filename: "inbound-image.png", contentType: "image/png" }],
          },
          sessionID: session.id,
          messageID: "msg_channel_image_00000000000000000000000",
        })

        const imagePart = parts.find((part) => part.type === "attachment")
        expect(imagePart?.type).toBe("attachment")
        if (imagePart?.type !== "attachment") return
        expect(imagePart.localPath).toBeTruthy()
        expect(imagePart.localPath).not.toBe(filepath)
        // The persisted copy survives cleanup of the inbound temp file, so a
        // later look_at(file_path=...) call and materialized history stay valid.
        await fs.unlink(filepath)
        expect(await Bun.file(imagePart.localPath!).exists()).toBe(true)
      },
    })
  })

  test("duplicate attachment replay does not read a cleaned source file", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()
        if (!lease) throw new Error("expected lease")

        const filepath = path.join(tmp.path, "replayed-attachment.txt")
        await Bun.write(filepath, "durable attachment")
        const deliveryKey = `channel:feishu:account_busy:${FEISHU_MESSAGE_ID}:attachment`
        const prepareParts = () =>
          ChannelBusyHandoff.buildDurablePromptParts({
            ctx: {
              channelType: "feishu",
              accountId: "account_busy",
              chatId: "chat_busy",
              chatType: "dm",
              senderId: CHANNEL_REQUESTER,
              text: "attachment replay",
              messageId: FEISHU_MESSAGE_ID,
              timestamp: Date.now(),
              attachments: [{ path: filepath, filename: "replayed-attachment.txt", contentType: "text/plain" }],
            },
            sessionID: session.id,
            messageID: "",
          })

        try {
          const first = await ChannelConversationAcceptance.accept({
            sessionID: session.id,
            deliveryKey,
            prepareParts,
            metadata: { channelReply: true },
            execute: async () => {
              throw new Error("busy acceptance must not execute")
            },
          })
          expect(first.accepted).toBe(true)
          expect(await SessionInbox.list(session.id)).toHaveLength(1)

          await fs.unlink(filepath)
          const replay = await ChannelConversationAcceptance.accept({
            sessionID: session.id,
            deliveryKey,
            prepareParts,
            metadata: { channelReply: true },
            execute: async () => {
              throw new Error("duplicate replay must not execute")
            },
          })
          expect(replay.accepted).toBe(true)
          expect(await SessionInbox.list(session.id)).toHaveLength(1)
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
        }
      },
    })
  })

  test("non-image attachment materializes as an asset URL after the source temp file is deleted", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const filepath = path.join(tmp.path, "inbound-file.pdf")
        await Bun.write(filepath, "%PDF-1.4 test pdf content")

        const part = await Attachment.toPart({
          filepath,
          mime: "application/pdf",
          filename: "inbound-file.pdf",
          sessionID: session.id,
          messageID: "msg_durable_pdf_00000000000000000000000",
        })
        expect(part.url.startsWith("asset://")).toBe(true)
        expect(part.model?.mode).toBe("summary")

        await SessionInbox.deliverUnique({
          sessionID: session.id,
          deliveryKey: `feishu-attachment-pdf:${FEISHU_MESSAGE_ID}`,
          mode: "task",
          message: {
            role: "user",
            parts: [part],
            visible: true,
            origin: { type: "channel", label: "feishu" },
          },
        })

        await fs.unlink(filepath)
        await expect(fs.access(filepath)).rejects.toThrow()

        const items = await SessionInbox.list(session.id)
        const materialized = await SessionInbox.materializeItem(items[0])
        if (!materialized) throw new Error("expected materialized message")
        const attachmentPart = materialized?.parts.find((p) => p.type === "attachment")
        if (attachmentPart?.type !== "attachment") throw new Error("expected materialized attachment")
        expect(attachmentPart.url).toBe(part.url)
        expect(attachmentPart.url.startsWith("asset://")).toBe(true)
        expect(attachmentPart.model?.mode).toBe("summary")
        const assetPath = Asset.resolvePath(attachmentPart.url.slice("asset://".length))
        expect(attachmentPart.localPath).toBe(assetPath)
        expect(await Bun.file(attachmentPart.localPath!).text()).toBe("%PDF-1.4 test pdf content")
        const modelInput = JSON.stringify(MessageV2.toModelMessage([materialized]))
        expect(modelInput).toContain(assetPath!)
        expect(modelInput).not.toContain(filepath)
      },
    })
  })
})
