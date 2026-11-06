import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import type { MessageV2 } from "../../src/session/message-v2"
import { CompactionRegion } from "../../src/session/compaction-region"

const info = (id: string, created: number): MessageV2.User => ({
  id,
  role: "user",
  sessionID: "ses_region",
  time: { created },
  agent: "test",
  model: { providerID: "test", modelID: "test" },
})

describe("compaction regions", () => {
  test("preserves complete call/result groups and every unselected source", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Do not edit until approved" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: {} }] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "result" } },
        ],
      },
      { role: "assistant", content: "same-source attachment explanation" },
      { role: "user", content: "latest task" },
    ]
    const sources = ["constraint", "call", "result", "result", "root"]
    const projection = CompactionRegion.project({
      messages,
      messageSources: sources,
      rootID: "root",
      infos: [info("constraint", 1), info("call", 2), info("result", 3), info("root", 4)],
    })
    expect(projection.groups.map((group) => group.messageIDs)).toEqual([["constraint"], ["call", "result"]])
    expect(CompactionRegion.indexes(projection, 1)).toEqual([0, 4])
    expect(CompactionRegion.indexes(projection, 2)).toEqual([0, 1, 2, 3, 4])
    for (const count of [2, 1]) {
      const selected = new Set(CompactionRegion.indexes(projection, count))
      expect([...selected, ...messages.flatMap((_, index) => (selected.has(index) ? [] : [index]))].sort()).toEqual([
        0, 1, 2, 3, 4,
      ])
    }
  })

  test("selects the oldest fitting prefix, retains a recent tail and shrinks monotonically", () => {
    expect(CompactionRegion.select([20, 20, 20, 20, 20], 100)).toBe(4)
    expect(CompactionRegion.select([70, 20, 20], 60)).toBe(0)
    expect(CompactionRegion.select([20, 20, 20, 20, 20], 50)).toBe(2)
    expect([8, 4, 2, 1].map(CompactionRegion.shrink)).toEqual([4, 2, 1, 0])
  })

  test("does not join separate completed exchanges when a provider reuses a call ID", () => {
    const exchange: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "reused", toolName: "read", input: {} }] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "reused", toolName: "read", output: { type: "text", value: "result" } },
        ],
      },
    ]
    const projection = CompactionRegion.project({
      messages: [...exchange, ...exchange],
      messageSources: ["first", "first", "second", "second"],
      infos: [info("first", 1), info("second", 2)],
      rootID: "root",
    })
    expect(projection.groups.map((group) => group.messageIDs)).toEqual([["first"], ["second"]])
  })

  test("rejects a source map that cannot prove request coverage", () => {
    expect(() =>
      CompactionRegion.project({
        messages: [{ role: "user", content: "history" }],
        messageSources: [],
        infos: [],
        rootID: "root",
      }),
    ).toThrow("sources")
  })

  test("a subsequent prefix includes its summary and advances across the next complete source", () => {
    const previous: MessageV2.Assistant = {
      id: "summary",
      role: "assistant",
      sessionID: "ses_region",
      parentID: "old-root",
      time: { created: 9 },
      modelID: "test",
      providerID: "test",
      mode: "compaction",
      agent: "compaction",
      path: { cwd: null, root: null },
      summary: true,
      finish: "stop",
      compaction: { coveredThrough: { created: 2, messageID: "covered" } },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const projection = CompactionRegion.project({
      messages: [
        { role: "user", content: "root" },
        { role: "user", content: "previous root predates the covered cursor" },
        { role: "assistant", content: "previous summary" },
        { role: "user", content: "next constraint" },
        { role: "user", content: "recent tail" },
        { role: "user", content: "ephemeral instruction" },
      ],
      messageSources: ["root", "old-root", "summary", "next", "tail", "ephemeral"],
      infos: [info("old-root", 1), info("next", 3), info("tail", 4), previous, info("root", 10)],
      rootID: "root",
    })
    expect(projection.groups[0]).toEqual({
      messageIDs: ["summary", "old-root", "next"],
      indexes: [2, 1, 3],
      coveredThrough: { created: 3, messageID: "next" },
    })
    expect(CompactionRegion.indexes(projection, 1)).toEqual([0, 1, 2, 3, 5])
    expect(CompactionRegion.select([40, 10], 30)).toBe(0)
    expect(CompactionRegion.select([40, 10], 0)).toBe(0)
    expect(CompactionRegion.select([], 50)).toBe(0)
    expect(CompactionRegion.select([40, 10], Infinity)).toBe(2)
  })
})
