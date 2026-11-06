import { expect, test } from "bun:test"
import { browserBackendCommandTimeoutMs } from "../src/protocol"

test("the Host allows lazy initialization before a full requested wait or evaluation", () => {
  expect(
    browserBackendCommandTimeoutMs({ type: "wait", condition: { type: "load" }, timeoutMs: 60_000 }),
  ).toBeGreaterThanOrEqual(95_000)
  expect(
    browserBackendCommandTimeoutMs({ type: "evaluate", mode: "readonly", expression: "1", timeoutMs: 120_000 }),
  ).toBeGreaterThanOrEqual(155_000)
})
test("the Host does not expire before action resolution, dispatch, settling and snapshot", () => {
  expect(
    browserBackendCommandTimeoutMs({
      type: "action",
      action: { type: "click", target: { selector: "#submit" }, timeoutMs: 120_000, settleTimeoutMs: 30_000 },
    }),
  ).toBeGreaterThanOrEqual(199_000)
  expect(
    browserBackendCommandTimeoutMs({ type: "navigate", url: "https://example.com", source: "agent" }),
  ).toBeGreaterThanOrEqual(64_000)
})
