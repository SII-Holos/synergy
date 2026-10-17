import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  filesystemObjectID,
  identifyDirectory,
  readOrCreateIdentityFile,
  matchesLegacyFilesystemIdentity,
} from "../src/filesystem-identity"

test("legacy remount compatibility requires the same inode and known birth time", () => {
  expect(matchesLegacyFilesystemIdentity("10:42:123456789", "11:42:123456789", true)).toBe(true)
  expect(matchesLegacyFilesystemIdentity("10:42:123456789", "11:42:123456789")).toBe(false)
  expect(matchesLegacyFilesystemIdentity("10:42:123456789", "10:42:123456789")).toBe(true)
  for (const actual of [
    undefined,
    "11:43:123456789",
    "11:42:123456790",
    "11:42:0",
    "volume-v1:volume:42:123456789",
    "overlay:11:42",
    "bad",
  ])
    expect(matchesLegacyFilesystemIdentity("10:42:123456789", actual, true)).toBe(false)
  for (const previous of ["10:42:0", "10:0:123456789", "volume-v1:volume:42:123456789", "overlay:10:42", "bad"])
    expect(matchesLegacyFilesystemIdentity(previous, "11:42:123456789", true)).toBe(false)
})

test("persistent volume identity survives device reassignment without accepting another object", () => {
  const stat = { dev: 10n, ino: 42n, birthtimeNs: 123456789n }
  const original = filesystemObjectID(stat, "volume-a")
  expect(filesystemObjectID({ ...stat, dev: 11n }, "volume-a")).toBe(original)
  expect(filesystemObjectID(stat, "volume-b")).not.toBe(original)
  expect(filesystemObjectID({ ...stat, ino: 43n }, "volume-a")).not.toBe(original)
  expect(filesystemObjectID({ ...stat, birthtimeNs: 123456790n }, "volume-a")).not.toBe(original)
  expect(filesystemObjectID(stat)).toBe("10:42:123456789")
})

test("directory identity survives child writes, metadata changes and rename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-identity-"))
  try {
    const directory = path.join(root, "files")
    await fs.mkdir(directory)
    const initial = await identifyDirectory(directory)
    await fs.writeFile(path.join(directory, "child"), "first")
    await fs.mkdir(path.join(directory, "nested"))
    await fs.rename(path.join(directory, "child"), path.join(directory, "nested", "child"))
    await fs.chmod(directory, 0o750)
    expect((await identifyDirectory(directory)).physicalID).toBe(initial.physicalID)
    const renamed = path.join(root, "renamed")
    await fs.rename(directory, renamed)
    expect((await identifyDirectory(renamed)).physicalID).toBe(initial.physicalID)
    await fs.mkdir(directory)
    expect((await identifyDirectory(directory)).physicalID).not.toBe(initial.physicalID)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("persistent identities converge and directory replacement is distinguishable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-identity-"))
  try {
    const file = path.join(root, "identity")
    const [a, b] = await Promise.all([readOrCreateIdentityFile(file), readOrCreateIdentityFile(file)])
    expect(a).toBe(b)
    expect(await readOrCreateIdentityFile(file)).toBe(a)
    const directory = path.join(root, "files")
    await fs.mkdir(directory)
    const original = await identifyDirectory(directory)
    await fs.rename(directory, path.join(root, "old"))
    await fs.mkdir(directory)
    expect((await identifyDirectory(directory)).physicalID).not.toBe(original.physicalID)
    await expect(identifyDirectory(path.join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await identifyDirectory(path.join(root, "missing"), true)).physicalID).toBeUndefined()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
