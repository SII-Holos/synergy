import { describe, expect, test } from "bun:test"
import { FeishuStreamingCard } from "../../src/channel/provider/feishu/streaming-card"
import { FeishuStreamingState } from "../../src/channel/provider/feishu/streaming-state"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../fixture/fixture"

function response(input: { status?: number; code?: number; msg?: string; data?: Record<string, unknown> } = {}) {
  return new Response(
    JSON.stringify({
      code: input.code ?? 0,
      msg: input.msg,
      data: input.data,
    }),
    { status: input.status ?? 200, headers: { "Content-Type": "application/json" } },
  )
}

function createCard(input: { sendFallback?: (text: string) => Promise<void>; accountId?: string; sessionID?: string }) {
  return new FeishuStreamingCard({
    apiBase: "https://open.feishu.test/open-apis",
    getAccessToken: async () => "token_test",
    chatId: "chat_test",
    replyToMessageId: "message_root",
    throttleMs: 0,
    sendFallback: input.sendFallback,
    persistence:
      input.accountId && input.sessionID ? { accountId: input.accountId, sessionID: input.sessionID } : undefined,
  })
}

describe("Feishu streaming lifecycle", () => {
  test("persists an active card and removes it after terminal close", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input) => {
          const url = String(input)
          if (url.endsWith("/cardkit/v1/cards")) return response({ data: { card_id: "card_persisted" } })
          if (url.endsWith("/im/v1/messages/message_root/reply")) {
            return response({ data: { message_id: "message_card" } })
          }
          return response()
        }) as typeof fetch

        try {
          const card = createCard({ accountId: "acct_test", sessionID: "session_test" })
          await card.start()

          expect(await Storage.read(StoragePath.channelFeishuStreamingCard("acct_test", "session_test"))).toMatchObject(
            { version: 1, cardId: "card_persisted" },
          )

          await card.close("final answer")
          await expect(
            Storage.read(StoragePath.channelFeishuStreamingCard("acct_test", "session_test")),
          ).rejects.toBeInstanceOf(Storage.NotFoundError)
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test("closes orphaned cards with a recovery sequence above every live mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Storage.write(StoragePath.channelFeishuStreamingCard("acct_test", "session_test"), {
          version: 1,
          cardId: "card_orphaned",
          messageId: "message_card",
          startedAt: Date.now(),
        })
        const originalFetch = globalThis.fetch
        let sequence = 0
        globalThis.fetch = (async (_input, init) => {
          sequence = Number((JSON.parse(String(init?.body)) as { sequence?: number }).sequence)
          return response()
        }) as typeof fetch

        try {
          expect(
            await FeishuStreamingState.reconcileAccount({
              accountId: "acct_test",
              apiBase: "https://open.feishu.test/open-apis",
              getAccessToken: async () => "token_test",
            }),
          ).toBe(1)
          expect(sequence).toBe(2_147_483_647)
          await expect(
            Storage.read(StoragePath.channelFeishuStreamingCard("acct_test", "session_test")),
          ).rejects.toBeInstanceOf(Storage.NotFoundError)
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test("preserves orphan state when recovery fails transiently", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const key = StoragePath.channelFeishuStreamingCard("acct_test", "session_test")
        await Storage.write(key, {
          version: 1,
          cardId: "card_retry_later",
          messageId: "message_card",
          startedAt: Date.now(),
        })
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () =>
          response({ status: 502, code: 230099, msg: "system busy" })) as unknown as typeof fetch

        try {
          expect(
            await FeishuStreamingState.reconcileAccount({
              accountId: "acct_test",
              apiBase: "https://open.feishu.test/open-apis",
              getAccessToken: async () => "token_test",
            }),
          ).toBe(0)
          expect(await Storage.read(key)).toMatchObject({ cardId: "card_retry_later" })
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })
})
