import { describe, expect, test } from "bun:test"
import { InMemoryFilesystem } from "../../src/hashline/fs"
import { Patch } from "../../src/hashline/input"
import { Patcher } from "../../src/hashline/patcher"
import { InMemorySnapshotStore } from "../../src/hashline/snapshots"
import type { BlockResolver } from "../../src/hashline/types"

function resolverForImports(): BlockResolver {
  return ({ text, line }) => {
    const lines = text.split("\n")
    if (!lines[line - 1]?.startsWith("import")) return null
    let start = line
    while (start > 1 && lines[start - 2]?.startsWith("import")) start--
    let end = line
    while (end < lines.length && lines[end]?.startsWith("import")) end++
    return end > start ? { start, end } : null
  }
}

describe("block edit recovery through Patcher", () => {
  test("resolves SWAP.BLK against the matching snapshot when live content drifted", async () => {
    const fs = new InMemoryFilesystem()
    const snapshots = new InMemorySnapshotStore()
    const path = "src/a.ts"
    const snapshot = "import a\nimport b\nconst value = 1\n"
    const tag = snapshots.record(path, snapshot, [1, 2])
    fs.set(path, "// preamble\nimport a\nimport b\nconst value = 1\n")

    const patch = Patch.parse(`[${path}#${tag}]\nSWAP.BLK 1:\n+import x\n+import y\n`)
    const patcher = new Patcher({ fs, snapshots, blockResolver: resolverForImports() })

    const prepared = await patcher.prepare(patch.sections[0])
    expect(prepared.applyResult.text).toContain("import x\nimport y")
    expect(prepared.applyResult.warnings?.join("\n")).toMatch(/Recovered/i)
  })

  test("refuses SWAP.BLK when no block resolver is available", async () => {
    const fs = new InMemoryFilesystem()
    const snapshots = new InMemorySnapshotStore()
    const path = "src/a.ts"
    const text = "import a\nimport b\n"
    const tag = snapshots.record(path, text, [1, 2])
    fs.set(path, text)

    const patch = Patch.parse(`[${path}#${tag}]\nSWAP.BLK 1:\n+import x\n`)
    const patcher = new Patcher({ fs, snapshots })

    await expect(patcher.prepare(patch.sections[0])).rejects.toThrow(/block resolver/i)
  })

  test("lowers INS.BLK.POST to anchored insert when unresolved", async () => {
    const fs = new InMemoryFilesystem()
    const snapshots = new InMemorySnapshotStore()
    const path = "src/a.ts"
    const text = "const value = 1\n"
    const tag = snapshots.record(path, text, [1])
    fs.set(path, text)

    const patch = Patch.parse(`[${path}#${tag}]\nINS.BLK.POST 1:\n+const next = 2\n`)
    const patcher = new Patcher({ fs, snapshots, blockResolver: () => null })

    const prepared = await patcher.prepare(patch.sections[0])
    expect(prepared.applyResult.text).toBe("const value = 1\nconst next = 2\n")
    expect(prepared.applyResult.warnings?.join("\n")).toMatch(/applied as plain/i)
  })
})
