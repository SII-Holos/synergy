import { expect, test } from "bun:test"
import { SnapshotLink } from "../../src/session/snapshot-link"

test("snapshot link envelopes preserve native kind and literal Unicode targets", () => {
  for (const kind of [undefined, "file", "dir", "junction"] as const) {
    const target = "\ufeff../中文 link\nwith\\slash"
    const bytes = SnapshotLink.encode({ kind, target })
    expect(SnapshotLink.decode(bytes)).toMatchObject({ target, ...(kind ? { kind } : {}) })
    expect(SnapshotLink.display(SnapshotLink.decode(bytes))).toContain("中文")
    expect(SnapshotLink.display(SnapshotLink.decode(bytes))).not.toContain("\0")
  }
})

test("invalid or unknown snapshot link encodings cannot become native paths", () => {
  for (const bytes of [
    Buffer.from(""),
    Buffer.from("a\0b"),
    Buffer.from([0xff]),
    Buffer.from("\0SynergySnapshotLink\0" + JSON.stringify({ version: 2, kind: "dir", target: "x" })),
    Buffer.from("\0SynergySnapshotLink\0" + JSON.stringify({ version: 1, kind: "future", target: "x" })),
    Buffer.from("\0SynergySnapshotLink\0{"),
    Buffer.alloc(256 * 1024 + 1, 97),
  ])
    expect(() => SnapshotLink.decode(bytes)).toThrow()
})
