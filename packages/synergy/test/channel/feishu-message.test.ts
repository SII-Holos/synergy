import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { FeishuProvider } from "../../src/channel/provider/feishu"
import {
  downloadMessageMedia,
  fetchQuotedMessage,
  MAX_FEISHU_ATTACHMENT_BYTES,
  parseMessageContent,
} from "../../src/channel/provider/feishu/message"
import type { Config } from "../../src/config/config"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function accountConfig(overrides: Partial<Config.ChannelFeishuAccount> = {}): Config.ChannelFeishuAccount {
  return {
    enabled: true,
    appId: "app",
    appSecret: "secret",
    allowDM: true,
    allowGroup: true,
    requireMention: false,
    streaming: true,
    streamingThrottleMs: 100,
    groupSessionScope: "group",
    inboundDebounceMs: 0,
    resolveSenderNames: false,
    replyInThread: false,
    ...overrides,
  }
}

function channelConfig(): Config.ChannelFeishu {
  return {
    type: "feishu",
    accounts: {},
    streaming: true,
    responseFormat: "markdown",
  }
}

const apiContext = {
  apiBase: "https://open.feishu.test/open-apis",
  getAccessToken: async () => "token_test",
}

function providerWithAccount(): FeishuProvider {
  const provider = new FeishuProvider()
  const accounts = (
    provider as unknown as {
      accounts: Map<string, unknown>
    }
  ).accounts
  accounts.set("acct_test", {
    config: accountConfig(),
    channelConfig: channelConfig(),
    apiBase: "https://open.feishu.test/open-apis",
    tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
  })
  return provider
}

async function buildMessageContext(
  provider: FeishuProvider,
  message: Record<string, unknown>,
  config = accountConfig(),
  sender: Record<string, unknown> = { sender_id: { open_id: "ou_user" }, sender_type: "user" },
): Promise<{
  chatType: "dm" | "group"
  text: string
  senderId: string
  senderName?: string
  wasMentioned?: boolean
  quotedContent?: string
  attachments?: Array<{ path: string; filename?: string; placeholder?: string }>
}> {
  return (
    provider as unknown as {
      buildMessageContext(
        accountId: string,
        config: Config.ChannelFeishuAccount,
        channelConfig: Config.ChannelFeishu,
        payload: unknown,
      ): Promise<{
        chatType: "dm" | "group"
        text: string
        senderId: string
        senderName?: string
        wasMentioned?: boolean
        quotedContent?: string
        attachments?: Array<{ path: string; filename?: string; placeholder?: string }>
      }>
    }
  ).buildMessageContext("acct_test", config, channelConfig(), {
    message,
    sender,
  })
}

async function cleanupContextAttachments(context: { attachments?: Array<{ path: string }> }): Promise<void> {
  await Promise.all(context.attachments?.map((attachment) => fs.unlink(attachment.path)) ?? [])
}

describe("Feishu sender identity", () => {
  test("falls back to senderId when sender name lookup fails and optional sender fields are null", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.includes("/contact/v3/users/ou_sender")) {
        return new Response(JSON.stringify({ code: 41050, msg: "no user authority error" }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const context = await buildMessageContext(
      providerWithAccount(),
      {
        message_id: "msg_sender",
        chat_id: "chat_test",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
      accountConfig({ resolveSenderNames: true }),
      { sender_id: { open_id: "ou_sender", user_id: null }, sender_type: "user" },
    )

    expect(context).toMatchObject({ senderId: "ou_sender", senderName: "ou_sender" })
  })

  test("uses alternate stable sender identifiers when open_id is unavailable", async () => {
    const message = {
      message_id: "msg_sender",
      chat_id: "chat_test",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
    }

    const userContext = await buildMessageContext(providerWithAccount(), message, accountConfig(), {
      sender_id: { user_id: "user_sender" },
      sender_type: "user",
    })
    const unionContext = await buildMessageContext(
      providerWithAccount(),
      { ...message, message_id: "msg_union_sender" },
      accountConfig(),
      { sender_id: { union_id: "on_sender", user_id: "user_sender" }, sender_type: "user" },
    )

    expect(userContext).toMatchObject({ senderId: "user_sender", senderName: "user_sender" })
    expect(unionContext).toMatchObject({ senderId: "on_sender", senderName: "on_sender" })
  })
})

describe("Feishu bot identity resolution", () => {
  test("resolves and caches the bot open_id before filtering required group mentions", async () => {
    const requests: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith("/bot/v3/info")) {
        return new Response(JSON.stringify({ code: 0, bot: { open_id: "ou_synergy" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.endsWith("/im/v1/chats/chat_test")) {
        return new Response(JSON.stringify({ code: 0, data: { name: "Release room" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const provider = providerWithAccount()
    const config = accountConfig({ requireMention: true })
    const message = {
      message_id: "msg_group",
      chat_id: "chat_test",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 deploy" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_synergy" }, name: "Synergy" }],
    }

    const first = await buildMessageContext(provider, message, config)
    const second = await buildMessageContext(provider, { ...message, message_id: "msg_group_2" }, config)

    expect(first).toMatchObject({ chatType: "group", wasMentioned: true })
    expect(second).toMatchObject({ chatType: "group", wasMentioned: true })
    expect(requests.filter((url) => url.endsWith("/bot/v3/info"))).toHaveLength(1)
  })
})

describe("Feishu message media", () => {
  test("recognizes Feishu media messages as video", () => {
    expect(parseMessageContent(JSON.stringify({ file_key: "file_video" }), "media")).toBe("[Video]")
  })

  test("fetches a structured quoted parent message once", async () => {
    const requests: string[] = []
    globalThis.fetch = (async (input) => {
      requests.push(String(input))
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            items: [
              {
                message_id: "msg_parent",
                msg_type: "file",
                body: { content: JSON.stringify({ file_key: "file_trace", file_name: "trace.json" }) },
              },
            ],
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    expect(await fetchQuotedMessage(apiContext, "msg_parent")).toEqual({
      messageId: "msg_parent",
      messageType: "file",
      content: JSON.stringify({ file_key: "file_trace", file_name: "trace.json" }),
      text: "[File]",
    })
    expect(requests).toEqual(["https://open.feishu.test/open-apis/im/v1/messages/msg_parent"])
  })

  test("downloads Feishu media video resources as files", async () => {
    let requested = ""
    globalThis.fetch = (async (input) => {
      requested = String(input)
      return new Response(new Uint8Array([0, 0, 0, 24]), {
        headers: { "Content-Type": "video/mp4", "Content-Length": "4" },
      })
    }) as typeof fetch

    const media = await downloadMessageMedia({
      ctx: apiContext,
      messageId: "msg_video",
      messageType: "media",
      content: JSON.stringify({ file_key: "file_video", file_name: "clip.mp4" }),
      maxBytes: MAX_FEISHU_ATTACHMENT_BYTES,
    })

    expect(requested).toEndWith("/im/v1/messages/msg_video/resources/file_video?type=file")
    expect(media).toMatchObject({ contentType: "video/mp4", fileName: "clip.mp4", size: 4 })
  })

  test("rejects oversized resources before reading the response body", async () => {
    let readStarted = false
    globalThis.fetch = (async () =>
      ({
        ok: true,
        headers: new Headers({ "Content-Length": String(MAX_FEISHU_ATTACHMENT_BYTES + 1) }),
        body: {
          cancel: async () => {},
          getReader() {
            readStarted = true
            throw new Error("response body must not be read")
          },
        },
      }) as unknown as Response) as unknown as typeof fetch

    const media = await downloadMessageMedia({
      ctx: apiContext,
      messageId: "msg_large",
      messageType: "file",
      content: JSON.stringify({ file_key: "file_large", file_name: "large.bin" }),
      maxBytes: MAX_FEISHU_ATTACHMENT_BYTES,
    })

    expect(media).toBeUndefined()
    expect(readStarted).toBe(false)
  })

  test("materializes quoted parent files into the current message context", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith("/im/v1/messages/msg_parent")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  message_id: "msg_parent",
                  msg_type: "file",
                  body: { content: JSON.stringify({ file_key: "file_trace", file_name: "trace.json" }) },
                },
              ],
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        )
      }
      if (url.includes("/im/v1/messages/msg_parent/resources/file_trace")) {
        return new Response(new TextEncoder().encode('{"trace":true}'), {
          headers: { "Content-Type": "application/json", "Content-Length": "14" },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const context = await buildMessageContext(providerWithAccount(), {
      message_id: "msg_current",
      parent_id: "msg_parent",
      chat_id: "chat_test",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "Analyze the trace" }),
    })

    expect(context.quotedContent).toBe("[File]")
    expect(context.attachments).toHaveLength(1)
    expect(context.attachments?.[0]).toMatchObject({
      filename: "trace.json",
      placeholder: "Quoted attachment: trace.json",
    })
    expect(await Bun.file(context.attachments![0].path).text()).toBe('{"trace":true}')
    await cleanupContextAttachments(context)
  })

  test("shares the attachment count budget across current and quoted messages", async () => {
    const currentImageKeys = Array.from({ length: 8 }, (_, index) => `img_${index}`)
    let quotedResourceRequested = false
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith("/im/v1/messages/msg_parent")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  message_id: "msg_parent",
                  msg_type: "file",
                  body: { content: JSON.stringify({ file_key: "quoted_file", file_name: "quoted.txt" }) },
                },
              ],
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        )
      }
      if (url.includes("/im/v1/messages/msg_current/resources/img_")) {
        return new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "image/png", "Content-Length": "1" },
        })
      }
      if (url.includes("/im/v1/messages/msg_parent/resources/quoted_file")) {
        quotedResourceRequested = true
        return new Response(new Uint8Array([1]), { headers: { "Content-Length": "1" } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const context = await buildMessageContext(providerWithAccount(), {
      message_id: "msg_current",
      parent_id: "msg_parent",
      chat_id: "chat_test",
      chat_type: "p2p",
      message_type: "post",
      content: JSON.stringify({
        content: currentImageKeys.map((imageKey) => [{ tag: "img", image_key: imageKey }]),
      }),
    })

    expect(context.attachments).toHaveLength(8)
    expect(quotedResourceRequested).toBe(false)
    await cleanupContextAttachments(context)
  })

  test("shares the attachment byte budget across current and quoted messages", async () => {
    let quotedBodyRead = false
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith("/im/v1/messages/msg_parent")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  message_id: "msg_parent",
                  msg_type: "file",
                  body: { content: JSON.stringify({ file_key: "quoted_file", file_name: "quoted.txt" }) },
                },
              ],
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        )
      }
      if (url.includes("/im/v1/messages/msg_current/resources/current_file")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "Content-Type": "application/octet-stream", "Content-Length": "4" },
        })
      }
      if (url.includes("/im/v1/messages/msg_parent/resources/quoted_file")) {
        return {
          ok: true,
          headers: new Headers({ "Content-Length": String(MAX_FEISHU_ATTACHMENT_BYTES - 3) }),
          body: {
            cancel: async () => {},
            getReader() {
              quotedBodyRead = true
              throw new Error("quoted response body must not be read")
            },
          },
        } as unknown as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const context = await buildMessageContext(providerWithAccount(), {
      message_id: "msg_current",
      parent_id: "msg_parent",
      chat_id: "chat_test",
      chat_type: "p2p",
      message_type: "file",
      content: JSON.stringify({ file_key: "current_file", file_name: "current.bin" }),
    })

    expect(context.attachments).toHaveLength(1)
    expect(context.attachments?.[0].filename).toBe("current.bin")
    expect(quotedBodyRead).toBe(false)
    await cleanupContextAttachments(context)
  })
})
