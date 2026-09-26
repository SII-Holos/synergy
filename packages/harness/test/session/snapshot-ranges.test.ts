import { expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SnapshotRanges } from "../../src/session/snapshot-ranges"
import { SnapshotRecords } from "../../src/session/snapshot-records"

const workspace = { id: "wsp_source", generation: 1, root: "/work" }
const before = "a".repeat(40)
const after = "b".repeat(40)
const foreign = "c".repeat(40)
const last = "d".repeat(40)
function message(parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id: "msg_assistant",
      sessionID: "ses_owner",
      parentID: "msg_user",
      rootID: "msg_user",
      role: "assistant",
      providerID: "test",
      modelID: "test",
      mode: "synergy",
      agent: "synergy",
      time: { created: 1 },
      path: { cwd: workspace.root, root: workspace.root },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }
}
function patch(id: string, from: string, to?: string) {
  return MessageV2.PatchPart.parse({
    id,
    messageID: "msg_assistant",
    sessionID: "ses_owner",
    type: "patch",
    hash: from,
    workspace,
    files: ["same.txt"],
    operation: { toolCallID: "tool", status: to ? "complete" : "pending", afterHash: to },
  })
}

test("operation ranges never attribute intervening foreign writes to their owner", () => {
  const ranges = SnapshotRanges.fromMessages([
    message([patch("op_first", before, after), patch("op_last", foreign, last)]),
  ])
  expect(ranges).toEqual([
    { workspace, operationID: "op_first", from: before, to: after, files: ["same.txt"] },
    { workspace, operationID: "op_last", from: foreign, to: last, files: ["same.txt"] },
  ])
  expect(SnapshotRanges.merge(ranges, ranges)).toEqual(ranges)
})

test("a completed operation replaces its pending range without extending another operation", () => {
  const pending = SnapshotRanges.fromMessages([message([patch("op_first", before)])])
  const complete = SnapshotRanges.fromMessages([message([patch("op_first", before, after)])])
  expect(SnapshotRanges.merge(pending, complete)).toEqual(complete)
  expect(pending[0]).toMatchObject({ operationID: "op_first", incomplete: true })
})

test("snapshot retention includes both immutable operation endpoints", () => {
  expect(SnapshotRecords.partRoots(patch("op_first", before, after))).toEqual([before, after])
  expect(SnapshotRecords.partRoots({ ...patch("op_first", before), hash: "" })).toEqual([])
  expect(() => SnapshotRecords.partRoots({ type: "patch", hash: "" })).toThrow("Invalid historical")
})
