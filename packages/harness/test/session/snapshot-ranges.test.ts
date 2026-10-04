import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
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
      mode: PrimaryAgentIdentity.names.general,
      agent: PrimaryAgentIdentity.names.general,
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

test("operation evidence stays separate while workspace net changes include all writers", () => {
  const ranges = SnapshotRanges.fromMessages([
    message([patch("op_first", before, after), patch("op_last", foreign, last)]),
  ])
  expect(ranges).toEqual([
    {
      workspace,
      rootID: "msg_user",
      started: 1,
      operationID: "op_first",
      from: before,
      to: after,
      files: ["same.txt"],
    },
    { workspace, rootID: "msg_user", started: 1, operationID: "op_last", from: foreign, to: last, files: ["same.txt"] },
  ])
  expect(SnapshotRanges.merge(ranges, ranges)).toEqual(ranges)
  expect(SnapshotRanges.net(ranges)).toMatchObject([{ from: before, to: last, files: ["same.txt"] }])
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

test("net recording uses the first baseline and latest endpoint after an interrupted intermediate capture", () => {
  const ranges: SnapshotRanges.Range[] = [
    { workspace, checkpointID: "start", from: before, to: after, files: ["same.txt"], started: 1 },
    {
      workspace,
      checkpointID: "interrupted",
      from: after,
      incomplete: true,
      issue: "capture_failed",
      files: [],
      started: 2,
    },
    { workspace, checkpointID: "end", from: foreign, to: last, files: ["same.txt"], started: 3 },
  ]
  const net = SnapshotRanges.net(ranges)[0]!
  expect(net.from).toBe(before)
  expect(net.to).toBe(last)
  expect(net.incomplete).toBeFalsy()
  expect(net.issue).toBeUndefined()
  expect(ranges[1]?.issue).toBe("capture_failed")
})

test("temporary endpoint omissions do not hide a later complete net change", () => {
  const endpoint = (id: string, started: number, omissions: Array<{ file: string; reason: "size_limit" }>) => ({
    ...patch(id, before, after),
    operation: undefined,
    checkpoint: {
      version: 1 as const,
      rootID: "msg_user",
      segmentID: id,
      started,
      status: "complete" as const,
      afterHash: last,
      baselineOmissions: [],
      omissions,
    },
  })
  const ranges = SnapshotRanges.fromMessages([
    message([endpoint("first", 1, [{ file: "same.txt", reason: "size_limit" }]), endpoint("last", 2, [])]),
  ])
  expect(ranges[0]?.omissions).toHaveLength(1)
  expect(SnapshotRanges.net(ranges)[0]?.omissions).toEqual([])
  ranges[0]!.baselineOmissions = [{ file: "same.txt", reason: "size_limit" }]
  expect(SnapshotRanges.net(ranges)[0]?.omissions).toHaveLength(1)
})
