import { expect, test } from "bun:test"
import path from "path"
import { Channel } from "../../src/channel"
import { FeishuProvider } from "../../src/channel/provider/feishu"
import type { MessageHandler, Provider } from "../../src/channel/types"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

async function waitForHandler(read: () => MessageHandler | undefined): Promise<MessageHandler> {
  const deadline = Date.now() + 1_000
  while (!read()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Channel provider connection")
    await Bun.sleep(10)
  }
  return read()!
}

test("cleans inbound attachments across command and streaming startup exits", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      channel: {
        feishu: {
          type: "feishu",
          accounts: {
            cleanup: {
              enabled: true,
              appId: "app",
              appSecret: "secret",
              allowDM: true,
              allowGroup: true,
              requireMention: false,
              projectDir: "placeholder",
              streaming: true,
              streamingThrottleMs: 100,
              groupSessionScope: "group",
              inboundDebounceMs: 0,
              resolveSenderNames: false,
              replyInThread: false,
            },
          },
          streaming: true,
        },
      },
    },
  })

  const configPath = path.join(tmp.path, ".synergy", "synergy.d", "90-channels.jsonc")
  const config = await Bun.file(configPath).json()
  config.channel.feishu.accounts.cleanup.projectDir = tmp.path
  await Bun.write(configPath, JSON.stringify(config, null, 2))

  let onMessage: MessageHandler | undefined
  let failStreamingStart = false
  const replies: string[] = []
  const provider: Provider = {
    type: "feishu",
    async connect(input) {
      onMessage = input.onMessage
    },
    async replyMessage(input) {
      replies.push(input.messageId)
      return { messageId: "reply_sent" }
    },
    async pushMessage() {
      return { messageId: "push_sent" }
    },
    async addReaction() {},
    createStreamingSession() {
      return {
        async start() {
          if (failStreamingStart) throw new Error("streaming start failed")
        },
        async update() {},
        async updateToolProgress() {},
        async close() {},
        isActive: () => false,
      }
    },
  }

  Channel.registerProvider(provider)
  const scope = await tmp.scope()
  try {
    await ScopeContext.provide({
      scope,
      fn: async () => {
        try {
          await Channel.reload()
          await Channel.status()
          const handleMessage = await waitForHandler(() => onMessage)

          const commandAttachment = path.join(tmp.path, "command-attachment.txt")
          await Bun.write(commandAttachment, "command")
          await handleMessage({
            channelType: "feishu",
            accountId: "cleanup",
            chatId: "chat_test",
            chatType: "dm",
            senderId: "user_test",
            text: "/help",
            messageId: "msg_command",
            timestamp: Date.now(),
            attachments: [{ path: commandAttachment, contentType: "text/plain" }],
          })
          expect(replies).toEqual(["msg_command"])
          expect(await Bun.file(commandAttachment).exists()).toBe(false)

          failStreamingStart = true
          const startupAttachment = path.join(tmp.path, "startup-attachment.txt")
          await Bun.write(startupAttachment, "startup")
          await expect(
            handleMessage({
              channelType: "feishu",
              accountId: "cleanup",
              chatId: "chat_test",
              chatType: "dm",
              senderId: "user_test",
              text: "Analyze this file",
              messageId: "msg_startup",
              timestamp: Date.now(),
              attachments: [{ path: startupAttachment, contentType: "text/plain" }],
            }),
          ).rejects.toThrow("streaming start failed")
          expect(await Bun.file(startupAttachment).exists()).toBe(false)
        } finally {
          await Channel.stopAll()
        }
      },
    })
  } finally {
    Channel.registerProvider(new FeishuProvider())
  }
})
