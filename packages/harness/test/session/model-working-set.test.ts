import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { applyModelWorkingSetProjection, modelWorkingSetProjection } from "../../src/session/model-working-set"

function user(id: string, created: number): MessageV2.User {
  return {
    id,
    role: "user",
    sessionID: "ses_test",
    time: { created },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
  }
}

function summary(id: string, root: MessageV2.User, through: MessageV2.Info, created: number) {
  return {
    id,
    role: "assistant" as const,
    sessionID: root.sessionID,
    parentID: root.id,
    rootID: root.id,
    time: { created, completed: created },
    agent: "compaction",
    mode: "compaction",
    modelID: "test",
    providerID: "test",
    path: { cwd: null, root: null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: true,
    finish: "stop",
    compaction: { coveredThrough: { created: through.time.created, messageID: through.id } },
  }
}

function project(infos: MessageV2.Info[]) {
  const projection = modelWorkingSetProjection(infos)
  return projection
    ? applyModelWorkingSetProjection(
        infos,
        projection,
        (info) => info,
        (info) => ({ ...info, includeInContext: false }),
      )
    : infos
}

describe("compaction coverage", () => {
  test("replaces only the summarized prefix and preserves the unprocessed tail", () => {
    const old = user("msg_old", 1)
    const covered = user("msg_covered", 2)
    const tail = user("msg_tail", 3)
    const root = user("msg_root", 4)
    const compacted = summary("msg_summary", root, covered, 5)
    expect(project([old, covered, tail, root, compacted]).map((info) => info.id)).toEqual([
      root.id,
      compacted.id,
      tail.id,
    ])
  })

  test("successive summaries advance coverage without hiding the remaining tail", () => {
    const root = user("msg_root", 1)
    const first = user("msg_first", 2)
    const next = user("msg_next", 3)
    const tail = user("msg_tail", 4)
    const a = summary("msg_a", root, first, 5)
    const b = summary("msg_b", root, next, 6)
    const projected = project([root, first, next, tail, a, b])
    expect(projected.filter((info) => info.includeInContext !== false).map((info) => info.id)).toEqual([
      root.id,
      b.id,
      tail.id,
    ])
    expect(projected.find((info) => info.id === a.id)?.includeInContext).toBe(false)
    expect(project(projected)).toEqual(projected)
  })

  test("a failed attempt cannot advance the prior committed coverage", () => {
    const root = user("msg_root", 1)
    const first = user("msg_first", 2)
    const tail = user("msg_tail", 3)
    const a = summary("msg_a", root, first, 4)
    const failed = {
      ...summary("msg_failed", root, tail, 5),
      summary: undefined,
      finish: "error",
      includeInContext: false,
    }
    expect(
      project([root, first, tail, a, failed])
        .filter((info) => info.includeInContext !== false)
        .map((info) => info.id),
    ).toEqual([root.id, a.id, tail.id])
  })
})
