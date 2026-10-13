import { describe, expect, test } from "bun:test"
import { buildBossDeliveryHint } from "../src/prompt"

describe("boss delivery hint golden (explicit channel_push only, R6)", () => {
  test("no requester context still states the explicit-push contract", () => {
    expect(buildBossDeliveryHint(undefined)).toBe(
      [
        "<boss-delivery>",
        "本轮回复不会自动投递回渠道 — 用户看不到你的任何输出,除非你显式调用 channel_push 回传。",
        "需要向用户回执时,必须调用 channel_push(带 text,以及匹配的回执目标)。",
        "</boss-delivery>",
      ].join("\n"),
    )
  })

  test("a single requester names the chat and anchored message", () => {
    expect(buildBossDeliveryHint({ chatId: "oc_group_a", replyToMessageId: "om_msg_a" })).toBe(
      [
        "<boss-delivery>",
        "本轮回复不会自动投递回渠道 — 用户看不到你的任何输出,除非你显式调用 channel_push 回传。",
        "需要向用户回执时,必须调用 channel_push(带 text,以及匹配的回执目标)。",
        "当前回执目标 chat: oc_group_a; 回复消息: om_msg_a",
        "</boss-delivery>",
      ].join("\n"),
    )
  })

  test("a chat without an anchored message names only the chat", () => {
    expect(buildBossDeliveryHint({ chatId: "oc_group_a" })).toContain("当前回执目标 chat: oc_group_a")
  })

  test("an anchored message without a chat names only the message", () => {
    expect(buildBossDeliveryHint({ replyToMessageId: "om_msg_a" })).toContain("当前回执目标消息: om_msg_a")
  })
})
