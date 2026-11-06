import { expect, test } from "bun:test"
import type { AssistantMessage } from "@ericsanchezok/synergy-sdk/client"
import { sessionRecoveryMessage } from "../../src/components/session-recovery"

test("a manual recovery keeps its failed message until meaningful output or completion", () => {
  const failed = {
    id: "failed",
    error: { name: "APIError", data: { message: "Unavailable", isRetryable: true } },
  } as AssistantMessage
  const next = { id: "next" } as AssistantMessage
  expect(sessionRecoveryMessage([failed, next], () => [])).toBe(failed)
  expect(
    sessionRecoveryMessage([failed, next], () => [
      { id: "part", sessionID: "session", messageID: "next", type: "text", text: "" },
    ]),
  ).toBe(failed)
  expect(
    sessionRecoveryMessage([failed, next], () => [
      { id: "part", sessionID: "session", messageID: "next", type: "text", text: "Recovered" },
    ]),
  ).toBeUndefined()
  expect(sessionRecoveryMessage([failed, { ...next, finish: "stop" }], () => [])).toBeUndefined()
})
