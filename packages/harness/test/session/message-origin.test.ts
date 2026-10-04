import { expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

test("new Cortex deliveries retain their task reference and captured task title", () => {
  expect(
    MessageV2.originFromMetadata({
      source: "cortex",
      sourceSessionID: "child",
      sourceTaskID: "ctx_original",
      sourceTitle: "Inspect readiness",
    }),
  ).toEqual({ type: "cortex", sessionID: "child", taskID: "ctx_original", label: "Inspect readiness" })
})

test("historical Cortex references resolve only from the established delivery identity", () => {
  const message: MessageV2.User = {
    id: "msg_delivery",
    sessionID: "ses_parent",
    role: "user",
    time: { created: 1 },
    agent: "general",
    model: { providerID: "test", modelID: "test" },
    isRoot: false,
    origin: { type: "cortex", sessionID: "ses_child" },
    metadata: { inboxDeliveryKey: "cortex:taskNotification:ctx_original" },
  }
  const projected = MessageV2.deriveSemantics([{ info: message, parts: [] }])[0].info as MessageV2.User
  expect(projected.origin?.taskID).toBe("ctx_original")
  expect(message.origin?.taskID).toBeUndefined()
  const unrelated = MessageV2.deriveSemantics([
    { info: { ...message, metadata: { inboxDeliveryKey: "other:ctx_original" } }, parts: [] },
  ])[0].info as MessageV2.User
  expect(unrelated.origin?.taskID).toBeUndefined()
})
