import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"

test("initializes and reopens a writable SHA-1 object store", async () => {
  await using tmp = await tmpdir()
  const repo = path.join(tmp.path, "store.git")
  await SnapshotStore.initializeBareRepository(repo)
  const result = await SnapshotGit.run(
    ["git", "--git-dir", repo, "hash-object", "-w", "--stdin"],
    tmp.path,
    undefined,
    undefined,
    "retained content",
  )
  expect(result.exitCode).toBe(0)
  expect(result.text.trim()).toMatch(SnapshotStore.OID)
  await SnapshotStore.initializeBareRepository(repo)
  expect(await SnapshotStore.command(repo, ["cat-file", "blob", result.text.trim()])).toBe("retained content")
})

test("forces SHA-1 despite inherited hash defaults", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, ".gitconfig"), "[init]\n\tdefaultObjectFormat = sha256\n")
  const keys = ["HOME", "XDG_CONFIG_HOME", "GIT_DEFAULT_HASH"] as const
  const previous = keys.map((key) => process.env[key])
  try {
    process.env.HOME = tmp.path
    process.env.XDG_CONFIG_HOME = tmp.path
    process.env.GIT_DEFAULT_HASH = "sha256"
    const repo = path.join(tmp.path, "store.git")
    await SnapshotStore.initializeBareRepository(repo)
    expect(await SnapshotStore.command(repo, ["hash-object", "-t", "tree", "--stdin"])).toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    )
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
  }
})

test("rejects a non-SHA-1 repository before publishing its metadata", async () => {
  await using tmp = await tmpdir()
  const scopeID = path.basename(tmp.path)
  const repo = SnapshotStore.repository(scopeID)
  await SnapshotStore.initializeBareRepository(repo)
  await SnapshotStore.command(repo, ["config", "core.repositoryformatversion", "1"])
  await SnapshotStore.command(repo, ["config", "extensions.objectFormat", "sha256"])
  await expect(SnapshotStore.initializeRepository(scopeID)).rejects.toThrow()
  expect(await SnapshotStore.optional(StoragePath.snapshotRepository(scopeID))).toBeUndefined()
  expect(await Bun.file(path.join(repo, "HEAD")).exists()).toBe(true)
})

test("reports Git initialization diagnostics and leaves failed stores retryable", async () => {
  await using tmp = await tmpdir()
  const scopeID = path.basename(tmp.path)
  const repo = SnapshotStore.repository(scopeID)
  await Bun.write(repo, "obstruction")
  const error = await SnapshotStore.initializeRepository(scopeID).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(SnapshotStore.StorageError)
  expect((error as Error).message).toMatch(/Unable to initialize snapshot object store.*exit code 128/s)
  expect((error as Error).message).toContain("fatal:")
  expect((error as Error).cause).toMatchObject({ exitCode: 128, stderr: expect.stringContaining("fatal:") })
  expect(await SnapshotStore.optional(StoragePath.snapshotRepository(scopeID))).toBeUndefined()
  await fs.unlink(repo)
  await SnapshotStore.initializeRepository(scopeID)
  const expected = { version: 2, objectFormat: "sha1" }
  expect(await SnapshotStore.optional<typeof expected>(StoragePath.snapshotRepository(scopeID))).toEqual(expected)
})

test("reports hash-object verification diagnostics from an incomplete store", async () => {
  await using tmp = await tmpdir()
  const scopeID = path.basename(tmp.path)
  const repo = SnapshotStore.repository(scopeID)
  await fs.mkdir(repo, { recursive: true })
  await Bun.write(path.join(repo, "HEAD"), "ref: refs/heads/main\n")
  await Bun.write(path.join(repo, "config"), "this is not a valid config\n")
  const error = await SnapshotStore.initializeRepository(scopeID).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(SnapshotStore.StorageError)
  expect((error as Error).message).toMatch(/Snapshot git hash-object failed.*exit code 128/s)
  expect((error as Error).cause).toMatchObject({ exitCode: 128, stderr: expect.stringContaining("fatal:") })
  expect(await SnapshotStore.optional(StoragePath.snapshotRepository(scopeID))).toBeUndefined()
})
