import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotCapture } from "../../src/session/snapshot-capture"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("snapshot indexes, retained refs and pack transfers work beyond Windows MAX_PATH", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const deep = path.join(tmp.path, "nested-".repeat(12), "directory-".repeat(12))
    const repo = path.join(deep, "snapshot-store.git")
    const index = path.join(deep, "workspace-generation-".repeat(4), "index")
    expect(index.length).toBeGreaterThan(260)
    await fs.mkdir(path.dirname(index), { recursive: true })
    await SnapshotStore.initializeBareRepository(repo)
    const workspace = path.join(deep, "working-files")
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, "content.txt"), "original bytes\r\n")
    const args = ["git", "--git-dir", repo]
    expect(
      await SnapshotCapture.refresh({
        scopeID: "long-path",
        sessionID: "long-path",
        backend: "shared",
        repository: repo,
        workspace,
        index,
        temporary: path.dirname(index),
      }),
    ).toBe(true)
    const tree = await SnapshotGit.run([...args, "write-tree"], workspace, { GIT_INDEX_FILE: index })
    expect(tree.exitCode).toBe(0)
    const hash = tree.text.trim()
    expect(hash).toMatch(/^[a-f0-9]{40}$/)
    const ref = SnapshotStore.reference("ses_long_path", hash)
    await SnapshotStore.command(repo, ["update-ref", ref, hash])
    expect(await SnapshotGit.checked(repo, ["rev-parse", "--verify", ref])).toBe(hash)
    const inventory = path.join(deep, "inventory.txt")
    const objects: string[] = []
    for await (const object of SnapshotGit.lines(repo, ["rev-list", "--objects", "--no-object-names", hash]))
      objects.push(object)
    await fs.writeFile(inventory, objects.join("\n") + "\n")
    const target = path.join(deep, "imported-store.git")
    await SnapshotStore.initializeBareRepository(target)
    const pack = await SnapshotGit.importObjects(repo, target, inventory)
    expect(pack).toMatch(/^[a-f0-9]{40}$/)
    const content = await SnapshotGit.run(["git", "--git-dir", target, "show", `${hash}:content.txt`], workspace)
    expect(content.exitCode).toBe(0)
    expect(content.text).toBe("original bytes\r\n")
  }))
