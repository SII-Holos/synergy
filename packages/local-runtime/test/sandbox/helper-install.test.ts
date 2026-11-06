import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isTarballHelperUpToDate } from "../../src/sandbox/utils"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function helperPair(source: Buffer, destination: Buffer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-helper-install-"))
  temporaryDirectories.push(root)
  const sourcePath = path.join(root, "source-helper")
  const destinationPath = path.join(root, "installed-helper")
  await Promise.all([fs.writeFile(sourcePath, source), fs.writeFile(destinationPath, destination)])
  return { sourcePath, destinationPath }
}

describe("sandbox helper installation", () => {
  test("treats identical helper contents as current regardless of timestamps", async () => {
    const helper = await helperPair(Buffer.alloc(2_048, 1), Buffer.alloc(2_048, 1))
    const old = new Date("2020-01-01T00:00:00Z")
    const recent = new Date("2030-01-01T00:00:00Z")
    await fs.utimes(helper.sourcePath, old, old)
    await fs.utimes(helper.destinationPath, recent, recent)

    expect(isTarballHelperUpToDate(helper.sourcePath, helper.destinationPath)).toBe(true)
  })

  test("replaces a different installed helper even when its timestamp is newer", async () => {
    const helper = await helperPair(Buffer.alloc(2_048, 1), Buffer.alloc(2_048, 2))
    const old = new Date("2020-01-01T00:00:00Z")
    const recent = new Date("2030-01-01T00:00:00Z")
    await fs.utimes(helper.sourcePath, old, old)
    await fs.utimes(helper.destinationPath, recent, recent)

    expect(isTarballHelperUpToDate(helper.sourcePath, helper.destinationPath)).toBe(false)
  })
})
