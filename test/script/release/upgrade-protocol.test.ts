import { expect, test } from "bun:test"
import { upgradeProtocolEvidence } from "./upgrade-protocol"

test("upgrade failure evidence preserves repeated tool identities and root order without payloads", () => {
  const privateValue = "PRIVATE_FIXTURE_CONTENT"
  const evidence = upgradeProtocolEvidence([
    { info: { id: "user-private", role: "user", title: privateValue }, parts: [{ type: "text", text: privateValue }] },
    {
      info: { id: "assistant-private", role: "assistant", parentID: "user-private", finish: "tool-calls" },
      parts: [
        {
          type: "tool",
          callID: "private-call",
          state: { status: "completed", input: privateValue, output: privateValue },
        },
      ],
    },
    {
      info: { role: "assistant", parentID: "user-private", error: { message: privateValue }, finish: "error" },
      parts: [
        { type: "tool", callID: "private-call", state: { status: "completed" } },
        { type: "tool", callID: "another-private-call", state: { status: "error", error: privateValue } },
      ],
    },
  ])
  expect(evidence).toEqual([
    { role: "user", parent: null, error: null, finish: null, tools: [] },
    {
      role: "assistant",
      parent: 0,
      error: null,
      finish: "tool-calls",
      tools: [{ call: 0, callHash: expect.any(String), status: "completed", error: null, exit: null }],
    },
    {
      role: "assistant",
      parent: 0,
      error: { categories: ["unknown"], codes: [], cause: null },
      finish: "error",
      tools: [
        { call: 0, callHash: expect.any(String), status: "completed", error: null, exit: null },
        {
          call: 1,
          callHash: expect.any(String),
          status: "error",
          error: { categories: ["unknown"], codes: [], cause: null },
          exit: null,
        },
      ],
    },
  ])
  expect(evidence[1]!.tools[0]!.callHash).toBe(evidence[2]!.tools[0]!.callHash)
  expect(JSON.stringify(evidence)).not.toContain("private")
  expect(JSON.stringify(evidence)).not.toContain(privateValue)
})

test("upgrade evidence treats malformed or unfamiliar states as unknown", () => {
  expect(
    upgradeProtocolEvidence([
      null,
      {
        info: { role: "PRIVATE_ROLE", finish: "PRIVATE_FINISH", parentID: "missing" },
        parts: [{ type: "tool", state: { status: "PRIVATE_STATUS" } }],
      },
    ]),
  ).toEqual([
    { role: "unknown", parent: null, error: null, finish: null, tools: [] },
    {
      role: "unknown",
      parent: null,
      error: null,
      finish: "unknown",
      tools: [{ call: null, callHash: null, status: "unknown", error: null, exit: null }],
    },
  ])
})

test("upgrade evidence distinguishes completed process exit from checkpoint and coordination failures", () => {
  const evidence = upgradeProtocolEvidence([
    {
      info: {
        role: "assistant",
        error: {
          name: "APIError",
          data: { message: "connection reset PRIVATE_PAYLOAD", statusCode: 503, isRetryable: true },
        },
      },
      parts: [
        {
          type: "tool",
          state: {
            status: "error",
            error: "checkpoint write failed PRIVATE_PATH",
            metadata: {
              exit: 0,
              toolDiagnostic: {
                message: "workspace lease lost PRIVATE_ID",
                metadata: { cause: { message: "SQLITE_BUSY: PRIVATE_PATH" } },
              },
            },
          },
        },
      ],
    },
  ])
  expect(evidence[0]!.error).toMatchObject({ categories: ["transport"], statusCode: 503, retryable: true })
  expect(evidence[0]!.tools[0]).toMatchObject({
    status: "error",
    exit: 0,
    error: { categories: ["storage", "coordination"], cause: { categories: ["storage"], codes: ["SQLITE_BUSY"] } },
  })
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE")
})

test("upgrade evidence bounds transcript and per-message tool diagnostics", () => {
  const evidence = upgradeProtocolEvidence(
    Array.from({ length: 80 }, () => ({
      info: { role: "assistant" },
      parts: Array.from({ length: 40 }, () => ({ type: "tool", state: { status: "completed" } })),
    })),
  )
  expect(evidence).toHaveLength(64)
  expect(evidence.every((message) => message.tools.length === 32)).toBe(true)
})
