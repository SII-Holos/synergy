import { describe, expect, test } from "bun:test"
import { buildBossDeliveryHint } from "../src/prompt"

describe("boss delivery hint golden (explicit channel_push only, R6)", () => {
  test("no requester context still states the explicit-push contract", () => {
    expect(buildBossDeliveryHint(undefined)).toBe(
      [
        "<boss-delivery>",
        "This turn is not delivered to the channel automatically. A receipt must be explicitly delivered to its recorded destination.",
        "</boss-delivery>",
      ].join("\n"),
    )
  })

  test("a single requester names the chat and anchored message", () => {
    expect(buildBossDeliveryHint({ chatId: "oc_group_a", replyToMessageId: "om_msg_a" })).toBe(
      [
        "<boss-delivery>",
        "This turn is not delivered to the channel automatically. A receipt must be explicitly delivered to its recorded destination.",
        "Receipt target chat: oc_group_a; reply to message: om_msg_a",
        "</boss-delivery>",
      ].join("\n"),
    )
  })

  test("a chat without an anchored message names only the chat", () => {
    expect(buildBossDeliveryHint({ chatId: "oc_group_a" })).toContain("Receipt target chat: oc_group_a")
  })

  test("an anchored message without a chat names only the message", () => {
    expect(buildBossDeliveryHint({ replyToMessageId: "om_msg_a" })).toContain("Receipt target message: om_msg_a")
  })
})
