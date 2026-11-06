import { expect, test } from "bun:test"
import { expectRetainedHistory } from "./upgrade-history"

const history = [
  { info: { id: "old-user", role: "user" }, parts: [{ type: "text", text: "Old task" }] },
  { info: { id: "old-assistant", role: "assistant" }, parts: [{ type: "text", text: "Old result" }] },
  { info: { id: "continued-user", role: "user" }, parts: [{ type: "text", text: "Continue" }] },
  {
    info: { id: "continued-assistant", role: "assistant" },
    parts: [
      { type: "tool", callID: "continued-call", state: { status: "completed", output: "Retained result" } },
      { type: "text", text: "Completed" },
    ],
  },
]

test("restart history permits derived titles without losing canonical message evidence", () => {
  expectRetainedHistory(
    history,
    history.map((message) => ({ ...message, info: { ...message.info, summary: { title: "Derived title" } } })),
  )
})

test("restart history rejects a retained user continuation without its assistant", () => {
  expect(() => expectRetainedHistory(history, history.slice(0, -1))).toThrow()
})

test("restart history rejects lost or altered completed tool evidence", () => {
  for (const parts of [
    [{ type: "text", text: "Completed" }],
    [
      { type: "tool", callID: "continued-call", state: { status: "completed", output: "Changed" } },
      { type: "text", text: "Completed" },
    ],
  ]) {
    const changed = history.map((message) =>
      message.info.id === "continued-assistant" ? { ...message, parts } : message,
    )
    expect(() => expectRetainedHistory(history, changed)).toThrow()
  }
})
