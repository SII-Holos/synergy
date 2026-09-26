import { describe, expect, test } from "bun:test"
import { SnapshotRanges } from "../../src/session/snapshot-ranges"
import type { MessageV2 } from "../../src/session/message-v2"
import type { SnapshotSchema } from "../../src/session/snapshot-schema"

function message(input: {
  workspace?: SnapshotSchema.Workspace
  directory: string
  from: string
  to: string
}): MessageV2.WithParts {
  const base = { id: input.from, messageID: input.from, sessionID: "test" }
  return {
    info: {
      id: input.from,
      role: "assistant",
      path: { cwd: input.directory, root: input.directory },
    } as MessageV2.Assistant,
    parts: [
      { ...base, type: "step-start", snapshot: input.from, workspace: input.workspace },
      { ...base, type: "patch", hash: input.from, files: [`${input.directory}/same.txt`], workspace: input.workspace },
      {
        ...base,
        type: "step-finish",
        snapshot: input.to,
        workspace: input.workspace,
        reason: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  }
}

describe("snapshot summary ranges", () => {
  test("keeps same-name files in independent Workspaces and binding generations", () => {
    const a = { id: "wsp_a", generation: 1, root: "/a" }
    const b = { id: "wsp_b", generation: 1, root: "/b" }
    const moved = { ...a, generation: 2, root: "/a2" }
    const ranges = SnapshotRanges.fromMessages([
      message({ workspace: a, directory: "/a", from: "a1", to: "a2" }),
      message({ workspace: b, directory: "/b", from: "b1", to: "b2" }),
      message({ workspace: moved, directory: "/a2", from: "a3", to: "a4" }),
      message({ workspace: a, directory: "/a", from: "a5", to: "a6" }),
    ])
    expect(ranges.map(({ from, to, files, workspace }) => ({ from, to, files, workspace }))).toEqual([
      { from: "a1", to: "a6", files: ["same.txt"], workspace: a },
      { from: "b1", to: "b2", files: ["same.txt"], workspace: b },
      { from: "a3", to: "a4", files: ["same.txt"], workspace: moved },
    ])
  })

  test("keeps legacy evidence separate without inventing binding authority", () => {
    const legacy = SnapshotRanges.fromMessages([message({ directory: "/old", from: "old1", to: "old2" })])
    const next = SnapshotRanges.fromMessages([
      message({ directory: "/old", workspace: { id: "wsp_a", generation: 1, root: "/old" }, from: "new1", to: "new2" }),
    ])
    const merged = SnapshotRanges.merge(legacy, next)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ from: "old1", to: "old2", legacyRoot: "/old", files: ["same.txt"] })
    expect(merged[0].workspace).toBeUndefined()
    expect(merged[1].workspace?.id).toBe("wsp_a")
  })
})
