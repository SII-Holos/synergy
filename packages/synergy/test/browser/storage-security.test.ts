import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BrowserExport } from "../../src/browser/export.js"
import { BrowserOwner } from "../../src/browser/owner.js"
import { BrowserStorage } from "../../src/browser/storage.js"

const created = new Set<string>()
const createdOwners: BrowserOwner.Info[] = []

afterEach(async () => {
  await Promise.all(Array.from(created, (filepath) => fs.rm(filepath, { force: true })))
  await Promise.all(
    createdOwners
      .splice(0)
      .flatMap((owner) =>
        [BrowserStorage.profileDir(owner), BrowserStorage.uploadsDir(owner), BrowserStorage.downloadsDir(owner)].map(
          (directory) => fs.rm(directory, { recursive: true, force: true }),
        ),
      ),
  )
  created.clear()
})

describe("Browser storage owner isolation", () => {
  test("hashes ambiguous and traversal-shaped owner fields into distinct contained paths", () => {
    const first = owner("scope:a", "b/c")
    const second = owner("scope", "a:b_c")
    const traversal = owner("../../outside", "../session")
    const paths = [first, second, traversal].map(BrowserStorage.pathForOwner)

    expect(new Set(paths).size).toBe(3)
    for (const filepath of paths) {
      expect(path.basename(filepath)).toMatch(/^[a-f0-9]{64}\.json$/)
      expect(path.basename(path.dirname(filepath))).toBe("sessions-v4")
    }
    expect(BrowserOwner.key(first)).not.toBe(BrowserOwner.key(second))
  })

  test("rejects unknown or oversized persisted state instead of reviving it", async () => {
    const targetOwner = owner("storage-schema", "invalid-state")
    createdOwners.push(targetOwner)
    const filepath = BrowserStorage.pathForOwner(targetOwner)
    created.add(filepath)
    await BrowserStorage.ensureOwnerDirs(targetOwner)
    await fs.writeFile(
      filepath,
      JSON.stringify({
        version: BrowserStorage.CURRENT_VERSION,
        status: "suspended",
        page: { id: "page", url: "https://example.com", title: "x".repeat(20_001) },
        timestamp: Date.now(),
        unexpected: true,
      }),
      { mode: 0o600 },
    )

    expect(await BrowserStorage.load(targetOwner)).toBeNull()
  })
})

describe("Browser export containment", () => {
  test("uses canonical workspace parents and rejects traversal and symlink escapes", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-export-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-outside-"))
    try {
      await fs.symlink(outside, path.join(workspace, "escape"))
      await expect(BrowserExport.fileTarget(workspace, "../outside.json")).rejects.toThrow("inside the workspace")
      await expect(BrowserExport.fileTarget(workspace, "escape/created/outside.json")).rejects.toThrow("unsafe")
      expect(await fs.stat(path.join(outside, "created")).catch(() => null)).toBeNull()
      const realWorkspace = await fs.realpath(workspace)
      const file = await BrowserExport.fileTarget(workspace, "nested/report.json")
      expect(file).toBe(path.join(realWorkspace, "nested", "report.json"))
      const directory = await BrowserExport.createDirectory(workspace, "bundle")
      expect(directory).toBe(path.join(realWorkspace, "bundle"))
      await expect(BrowserExport.createDirectory(workspace, "bundle")).rejects.toMatchObject({ code: "EEXIST" })
    } finally {
      await Promise.all([
        fs.rm(workspace, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ])
    }
  })
})

function owner(scopeID: string, sessionID: string): BrowserOwner.Info {
  return { mode: "session", scopeID, sessionID, directory: "/tmp/workspace" }
}
