import { expect, test } from "bun:test"
import { nativeOutcome } from "../runtime/native-outcome.mjs"

test("native errors remain failures even when the CLI exits zero", () => {
  expect(
    nativeOutcome("pi", [
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429" } },
    ]),
  ).toEqual({ status: "failed", error: "429" })
  expect(nativeOutcome("codex", [{ type: "turn.failed", error: { message: "stream interrupted" } }]).status).toBe(
    "failed",
  )
  expect(
    nativeOutcome("opencode", [{ type: "error", error: { name: "APIError", data: { message: "500" } } }]).status,
  ).toBe("failed")
})

test("an error followed by a native retry success is a completed agent with all calls retained", () => {
  expect(
    nativeOutcome("pi", [
      { type: "message_end", message: { role: "assistant", stopReason: "error" } },
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    ]).status,
  ).toBe("completed")
  expect(nativeOutcome("codex", []).status).toBe("unknown")
})
