import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { SnapshotDurability } from "../../src/session/snapshot-durability"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const runtime = await testRuntime()

test("mount qualification retains filesystem and local flags without assuming filesystem numbers", () => {
  expect(
    SnapshotDurability.mounts(
      [
        "/dev/disk3s1 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
        "server:/share on /Volumes/remote (nfs, nodev)",
        "/dev/disk4 on /Volumes/two\\040words (hfs, local)",
      ].join("\n"),
    ),
  ).toEqual([
    { path: "/System/Volumes/Data", flags: ["apfs", "local", "journaled", "nobrowse"] },
    { path: "/Volumes/remote", flags: ["nfs", "nodev"] },
    { path: "/Volumes/two words", flags: ["hfs", "local"] },
  ])
})

test("tree durability policy leaves repository and reference synchronization unchanged", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "policy.git")
    await SnapshotStore.initializeBareRepository(repo)
    const before = await SnapshotGit.checked(repo, ["config", "--get", "core.fsync"])
    const options = await SnapshotDurability.treeOptions(repo)
    expect(options.length === 0 || options.join(" ") === "-c core.fsyncMethod=batch").toBe(true)
    expect(await SnapshotGit.checked(repo, ["config", "--get", "core.fsync"])).toBe(before)
    expect(await SnapshotGit.checked(repo, ["config", "--get", "core.fsyncMethod"])).toBe("fsync")
    const cancelled = new AbortController()
    cancelled.abort()
    if (process.platform === "darwin")
      await expect(SnapshotDurability.treeOptions(repo, cancelled.signal)).rejects.toThrow()
  }))

afterAll(() => runtime.close())
