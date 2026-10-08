import * as ConnectionsConfigSchema from "@ericsanchezok/synergy-connections/config-schema"
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_FEISHU_REACTION_ONLY_EMOJI,
  FEISHU_REACTION_TYPE_INVALID_CODE,
  FeishuReactionEmoji,
  isFeishuReactionOnlyAvailable,
  isKnownFeishuReactionEmoji,
  normalizeFeishuReactionEmoji,
  resolveFeishuReactionOnlyReply,
  resolveFeishuStreaming,
} from "../../src/channel/provider/feishu/reaction-only"
import { FeishuProvider, FeishuReactionError } from "../../src/channel/provider/feishu"
import { ChannelTerminalIntent } from "../../src/channel/types"

function accountConfig(overrides: Record<string, unknown> = {}) {
  return ConnectionsConfigSchema.ChannelFeishuAccount.parse({
    appId: "app",
    appSecret: "secret",
    ...overrides,
  })
}

function providerWithAccount(config: Record<string, unknown>) {
  const provider = new FeishuProvider()
  const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
  accounts.set("acct_test", {
    config: accountConfig(config),
    channelConfig: {},
    apiBase: "https://open.feishu.test/open-apis",
    tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
  })
  return provider
}

describe("Feishu reaction-only config resolution", () => {
  test("is disabled when the account config omits it", () => {
    expect(resolveFeishuReactionOnlyReply({ account: accountConfig(), channel: {} })).toEqual({
      enabled: false,
      forceReaction: DEFAULT_FEISHU_REACTION_ONLY_EMOJI,
    })
  })

  test("is disabled when the section exists but enabled is not true", () => {
    const account = accountConfig({ reactionOnlyReply: { forceReaction: "DONE" } })
    expect(resolveFeishuReactionOnlyReply({ account, channel: {} }).enabled).toBe(false)
  })

  test("forces the configured reaction when enabled", () => {
    const account = accountConfig({ reactionOnlyReply: { enabled: true, forceReaction: "DONE" } })
    expect(resolveFeishuReactionOnlyReply({ account, channel: {} })).toEqual({
      enabled: true,
      forceReaction: "DONE",
    })
  })

  test("falls back to the built-in reaction when none is forced", () => {
    const account = accountConfig({ reactionOnlyReply: { enabled: true } })
    expect(resolveFeishuReactionOnlyReply({ account, channel: {} }).forceReaction).toBe(
      DEFAULT_FEISHU_REACTION_ONLY_EMOJI,
    )
  })

  test("rejects a non-string reaction value instead of trusting unparsed config", () => {
    const account = { reactionOnlyReply: { enabled: true, forceReaction: 42 } }
    expect(resolveFeishuReactionOnlyReply({ account, channel: {} }).forceReaction).toBe(
      DEFAULT_FEISHU_REACTION_ONLY_EMOJI,
    )
  })

  test("treats malformed config shapes as disabled", () => {
    expect(resolveFeishuReactionOnlyReply({ account: undefined, channel: undefined }).enabled).toBe(false)
    expect(resolveFeishuReactionOnlyReply({ account: "nonsense", channel: 7 }).enabled).toBe(false)
    expect(resolveFeishuReactionOnlyReply({ account: { reactionOnlyReply: "yes" }, channel: {} }).enabled).toBe(false)
  })

  test("resolves streaming as account over channel over default", () => {
    expect(resolveFeishuStreaming({ account: {}, channel: {} })).toBe(true)
    expect(resolveFeishuStreaming({ account: {}, channel: { streaming: false } })).toBe(false)
    expect(resolveFeishuStreaming({ account: { streaming: true }, channel: { streaming: false } })).toBe(true)
    expect(resolveFeishuStreaming({ account: { streaming: false }, channel: { streaming: true } })).toBe(false)
  })

  test("is only available when enabled and not streaming", () => {
    expect(isFeishuReactionOnlyAvailable({ account: {}, channel: {} })).toBe(false)
    const enabled = { reactionOnlyReply: { enabled: true } }
    expect(isFeishuReactionOnlyAvailable({ account: enabled, channel: {} })).toBe(false)
    expect(isFeishuReactionOnlyAvailable({ account: { ...enabled, streaming: false }, channel: {} })).toBe(true)
    // A channel-level streaming:false must not make it available while the
    // account explicitly streams.
    expect(
      isFeishuReactionOnlyAvailable({ account: { ...enabled, streaming: true }, channel: { streaming: false } }),
    ).toBe(false)
  })
})

describe("Feishu reaction vocabulary", () => {
  test("accepts enum members and rejects unknown or blank values", () => {
    expect(isKnownFeishuReactionEmoji("SILENT")).toBe(true)
    expect(isKnownFeishuReactionEmoji("DONE")).toBe(true)
    expect(isKnownFeishuReactionEmoji("")).toBe(false)
    expect(isKnownFeishuReactionEmoji("not-a-reaction")).toBe(false)
  })

  test("accepts provider status reactions that are not offered to the model", () => {
    for (const emoji of ["Typing", "ERROR"]) {
      expect(isKnownFeishuReactionEmoji(emoji)).toBe(true)
      expect(FeishuReactionEmoji.safeParse(emoji).success).toBe(false)
    }
  })

  test("normalization is case-sensitive and trims surrounding whitespace", () => {
    expect(normalizeFeishuReactionEmoji(" DONE ")).toBe("DONE")
    expect(normalizeFeishuReactionEmoji("done")).toBeUndefined()
    expect(normalizeFeishuReactionEmoji(undefined)).toBeUndefined()
  })
})

describe("ChannelTerminalIntent", () => {
  test("parses a reaction-only intent that names a concrete reaction", () => {
    expect(ChannelTerminalIntent.parse({ type: "reaction_only", reaction: "DONE" })).toEqual({
      type: "reaction_only",
      reaction: "DONE",
    })
  })

  test("rejects unknown intents, missing or blank reactions, and extra keys", () => {
    expect(ChannelTerminalIntent.safeParse({ type: "normal" }).success).toBe(false)
    expect(ChannelTerminalIntent.safeParse({ type: "reaction_only" }).success).toBe(false)
    expect(ChannelTerminalIntent.safeParse({ type: "reaction_only", reaction: "" }).success).toBe(false)
    expect(ChannelTerminalIntent.safeParse({ type: "reaction_only", extra: true }).success).toBe(false)
  })
})

describe("Feishu addReaction", () => {
  test("returns the reaction id on success", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    let body: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input, init) => {
      calls++
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ code: 0, data: { reaction_id: "reaction_1" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const result = await providerWithAccount({}).addReaction({
        accountId: "acct_test",
        messageId: "om_message",
        emoji: "SILENT",
      })
      expect(calls).toBe(1)
      expect(body).toEqual({ reaction_type: { emoji_type: "SILENT" } })
      expect(result).toEqual({ reactionId: "reaction_1" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects a blank or unknown reaction locally without calling Feishu", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ code: 0 }), { headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch

    try {
      for (const emoji of ["", "   ", "nope"]) {
        const failure = await providerWithAccount({})
          .addReaction({ accountId: "acct_test", messageId: "om_message", emoji })
          .catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(FeishuReactionError)
        expect((failure as FeishuReactionError).code).toBe(FEISHU_REACTION_TYPE_INVALID_CODE)
      }
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("surfaces a Feishu business rejection as a failure with its code", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 231002, msg: "no permission" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch

    try {
      const failure = await providerWithAccount({})
        .addReaction({ accountId: "acct_test", messageId: "om_message", emoji: "SILENT" })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(FeishuReactionError)
      expect((failure as FeishuReactionError).code).toBe(231002)
      expect((failure as FeishuReactionError).status).toBe(400)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("treats an unparsable body as a failure rather than a success", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("not json", { status: 502, headers: { "Content-Type": "text/plain" } })) as unknown as typeof fetch

    try {
      const failure = await providerWithAccount({})
        .addReaction({ accountId: "acct_test", messageId: "om_message", emoji: "SILENT" })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(FeishuReactionError)
      expect((failure as FeishuReactionError).status).toBe(502)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("reports an unknown account as a failure", async () => {
    const failure = await new FeishuProvider()
      .addReaction({ accountId: "missing", messageId: "om_message", emoji: "SILENT" })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("Feishu account not found")
  })
})

describe("Feishu removeReaction", () => {
  test("surfaces a business rejection with its code", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 231003, msg: "message not found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch

    try {
      const failure = await providerWithAccount({})
        .removeReaction({ accountId: "acct_test", messageId: "om_message", reactionId: "reaction_1" })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(FeishuReactionError)
      expect((failure as FeishuReactionError).code).toBe(231003)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
