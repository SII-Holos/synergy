import { describe, expect, test } from "bun:test"
import {
  FeishuCardActionRouter,
  parseFeishuCardAction,
  type FeishuCardActionContext,
} from "../../src/channel/provider/feishu/card-action"

function callback(overrides: Record<string, unknown> = {}) {
  return {
    schema: "2.0",
    header: {
      event_id: "event_test",
      event_type: "card.action.trigger",
    },
    event: {
      operator: { open_id: "ou_actor" },
      action: {
        tag: "button",
        value: { synergy_builtin_action: "status" } as Record<string, unknown>,
      },
      context: {
        open_message_id: "om_card",
        open_chat_id: "oc_chat",
      },
    },
    ...overrides,
  }
}

const owner = {
  accountId: "acct_test",
  chatId: "oc_chat",
  chatType: "group" as const,
  senderId: "ou_original",
  rootId: "om_topic",
  groupSessionScope: "group_sender" as const,
}

describe("parseFeishuCardAction", () => {
  test("parses the documented schema 2.0 callback shape", () => {
    expect(parseFeishuCardAction(callback())).toEqual({
      kind: "action",
      eventId: "event_test",
      operatorOpenId: "ou_actor",
      messageId: "om_card",
      chatId: "oc_chat",
      action: "status",
    })
  })

  test("parses the flattened shape emitted by the Lark SDK", () => {
    expect(
      parseFeishuCardAction({
        event_id: "event_flat",
        operator: { open_id: "ou_actor" },
        value: { synergy_builtin_action: "help" },
        open_message_id: "om_card",
        open_chat_id: "oc_chat",
      }),
    ).toEqual({
      kind: "action",
      eventId: "event_flat",
      operatorOpenId: "ou_actor",
      messageId: "om_card",
      chatId: "oc_chat",
      action: "help",
    })
  })

  test("leaves unrelated plugin actions untouched", () => {
    const pluginInput = callback()
    pluginInput.event.action.value = { plugin_action: "custom" }
    expect(parseFeishuCardAction(pluginInput)).toEqual({ kind: "unhandled" })

    const legacyInput = callback()
    legacyInput.event.action.value = { synergy_action: "custom_plugin_action" }
    expect(parseFeishuCardAction(legacyInput)).toEqual({ kind: "unhandled" })
  })
})

describe("FeishuCardActionRouter", () => {
  test("acknowledges immediately and dispatches a validated action asynchronously", async () => {
    const router = new FeishuCardActionRouter()
    router.register("om_card", owner)
    let dispatchStarted = false

    let finish!: () => void
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    let started!: (ctx: FeishuCardActionContext) => void
    const dispatched = new Promise<FeishuCardActionContext>((resolve) => {
      started = resolve
    })

    const response = router.handle(callback(), "acct_test", async (ctx) => {
      dispatchStarted = true
      started(ctx)
      await blocked
    })

    expect(response).toEqual({
      toast: { type: "success", content: "操作已接收" },
    })

    await Promise.resolve()
    expect(dispatchStarted).toBe(false)

    const action = await dispatched
    expect(action).toEqual({
      channelType: "feishu",
      accountId: "acct_test",
      chatId: "oc_chat",
      chatType: "group",
      senderId: "ou_actor",
      scopeKey: "oc_chat:sender:ou_actor",
      messageId: "om_card",
      rootId: "om_topic",
      command: "status",
    })
    finish()
  })

  test("rejects missing operator identity without dispatching", async () => {
    const router = new FeishuCardActionRouter()
    router.register("om_card", owner)
    let dispatched = false
    const input = callback()
    input.event.operator = { open_id: "" }

    const response = router.handle(input, "acct_test", async () => {
      dispatched = true
    })
    await Bun.sleep(0)

    expect(response).toEqual({
      toast: { type: "error", content: "无法验证操作身份" },
    })
    expect(dispatched).toBe(false)
  })

  test("rejects unknown or mismatched card messages", async () => {
    const router = new FeishuCardActionRouter()
    router.register("om_card", owner)
    let dispatched = false

    const unknown = callback()
    unknown.event.context.open_message_id = "om_unknown"
    const unknownResponse = router.handle(unknown, "acct_test", async () => {
      dispatched = true
    })

    const wrongChat = callback({
      header: { event_id: "event_wrong_chat", event_type: "card.action.trigger" },
    })
    wrongChat.event.context.open_chat_id = "oc_other"
    const wrongChatResponse = router.handle(wrongChat, "acct_test", async () => {
      dispatched = true
    })
    await Bun.sleep(0)

    expect(unknownResponse).toEqual({
      toast: { type: "warning", content: "此操作已失效，请发送新消息" },
    })
    expect(wrongChatResponse).toEqual({
      toast: { type: "warning", content: "此操作已失效，请发送新消息" },
    })
    expect(dispatched).toBe(false)
  })

  test("rejects unknown Synergy actions and duplicate callback events", async () => {
    const router = new FeishuCardActionRouter()
    router.register("om_card", owner)
    let dispatchCount = 0
    let dispatched!: () => void
    const firstDispatch = new Promise<void>((resolve) => {
      dispatched = resolve
    })

    const malicious = callback()
    malicious.event.action.value = { synergy_builtin_action: "run_shell" }
    const maliciousResponse = router.handle(malicious, "acct_test", async () => {
      dispatchCount += 1
    })

    const first = callback({
      header: { event_id: "event_duplicate", event_type: "card.action.trigger" },
    })
    const second = callback({
      header: { event_id: "event_duplicate", event_type: "card.action.trigger" },
    })
    router.handle(first, "acct_test", async () => {
      dispatchCount += 1
      dispatched()
    })
    const duplicateResponse = router.handle(second, "acct_test", async () => {
      dispatchCount += 1
    })
    await firstDispatch

    expect(maliciousResponse).toEqual({
      toast: { type: "error", content: "不支持此操作" },
    })
    expect(duplicateResponse).toEqual({
      toast: { type: "info", content: "操作已接收" },
    })
    expect(dispatchCount).toBe(1)
  })

  test("only allows the original peer to act on a direct-message card", async () => {
    const router = new FeishuCardActionRouter()
    router.register("om_card", {
      ...owner,
      chatType: "dm",
      senderId: "ou_original",
      groupSessionScope: undefined,
    })
    let dispatched = false

    const response = router.handle(callback(), "acct_test", async () => {
      dispatched = true
    })
    await Bun.sleep(0)

    expect(response).toEqual({
      toast: { type: "error", content: "无法验证操作身份" },
    })
    expect(dispatched).toBe(false)
  })
})
