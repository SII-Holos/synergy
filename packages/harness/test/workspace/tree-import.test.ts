import { expect, test } from "bun:test"
import { WorkspaceTree } from "../../src/workspace/tree"

test("renaming an imported root cannot redirect a contained link outside its destination", () => {
  const tree = WorkspaceTree.Manifest.parse({
    version: 1,
    entries: [
      { kind: "directory", path: "entry", mode: 0o755 },
      {
        kind: "file",
        path: "entry/file",
        mode: 0o644,
        size: 0,
        hash: WorkspaceTree.hash(new Uint8Array()),
        chunks: [],
      },
      { kind: "symlink", path: "entry/link", mode: 0o777, target: "../entry/file" },
    ],
  })
  expect(() => WorkspaceTree.importEntries(tree, "destination")).toThrow("destination")
})

test("legacy entries and paged headers share exact import paths and literal link containment", () => {
  const entries: WorkspaceTree.Entry[] = [
    { kind: "directory", path: "entry", mode: 0o750 },
    { kind: "directory", path: "entry/nested", mode: 0o755 },
    { kind: "file", path: "entry/file", mode: 0o640, size: 0, hash: WorkspaceTree.hash(new Uint8Array()), chunks: [] },
    { kind: "symlink", path: "entry/nested/link", mode: 0o777, target: "../file" },
  ]
  const imported = WorkspaceTree.importEntries({ version: 1, entries }, "folder/destination")
  expect(imported.map((entry) => entry.path)).toEqual([
    "folder/destination",
    "folder/destination/nested",
    "folder/destination/file",
    "folder/destination/nested/link",
  ])
  expect(imported[3]).toMatchObject({ target: "../file" })
  expect(WorkspaceTree.importHeader(entries[2]!, "folder/destination")).not.toHaveProperty("chunks")
  for (const [index, entry] of entries.entries()) {
    const header: WorkspaceTree.Header =
      entry.kind === "file"
        ? {
            kind: entry.kind,
            path: entry.path,
            mode: entry.mode,
            size: entry.size,
            hash: entry.hash,
          }
        : entry
    expect(WorkspaceTree.importHeader(header, "folder/destination")).toEqual(
      entry.kind === "file" ? { ...header, path: imported[index]!.path } : imported[index],
    )
  }
  expect(() => WorkspaceTree.importHeader({ kind: "directory", path: "foreign", mode: 0o755 }, "dest")).toThrow(
    "source",
  )
  expect(() => WorkspaceTree.importHeader({ kind: "directory", path: "entry", mode: 0o755 }, "../dest")).toThrow()
})
