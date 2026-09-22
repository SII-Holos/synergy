import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { identifyDirectory, readOrCreateIdentityFile } from "../src/filesystem-identity"

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
