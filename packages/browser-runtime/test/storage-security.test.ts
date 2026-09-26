import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BrowserExport } from "../src/export.js"
import { BrowserOwner } from "../src/owner.js"
import { BrowserStorage } from "../src/storage.js"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()

const created = new Set<string[]>()
const createdOwners: BrowserOwner.Info[] = []

afterEach(() =>
  runtime.run(async () => {
    await Promise.all(Array.from(created, (filepath) => Storage.remove(filepath)))
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
  }),
)

describe("Browser storage owner isolation", () => {
  test("hashes ambiguous and traversal-shaped owner fields into distinct logical records", () =>
    runtime.run(() => {
      const first = owner("scope:a", "b/c")
      const second = owner("scope", "a:b_c")
      const traversal = owner("../../outside", "../session")
      const paths = [first, second, traversal].map(BrowserStorage.keyForOwner)

      expect(new Set(paths.map((key) => JSON.stringify(key))).size).toBe(3)
      for (const filepath of paths) {
        expect(filepath[2]).toMatch(/^[a-f0-9]{64}$/)
        expect(filepath.slice(0, 2)).toEqual(["browser", "sessions-v4"])
      }
      expect(BrowserOwner.key(first)).not.toBe(BrowserOwner.key(second))
    }))

  test("rejects unknown or oversized persisted state instead of reviving it", () =>
    runtime.run(async () => {
      const targetOwner = owner("storage-schema", "invalid-state")
      createdOwners.push(targetOwner)
      const filepath = BrowserStorage.keyForOwner(targetOwner)
      created.add(filepath)
      await BrowserStorage.ensureOwnerDirs(targetOwner)
      await Storage.write(filepath, {
        version: BrowserStorage.CURRENT_VERSION,
        status: "suspended",
        page: { id: "page", url: "https://example.com", title: "x".repeat(20_001) },
        timestamp: Date.now(),
        unexpected: true,
      })

      await expect(BrowserStorage.load(targetOwner)).rejects.toThrow()
    }))
})

describe("Browser export containment", () => {
  test("uses canonical workspace parents and rejects traversal and symlink escapes", () =>
    runtime.run(async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-export-"))
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-outside-"))
      try {
        await fs.symlink(outside, path.join(workspace, "escape"))
        await expect(BrowserExport.fileTarget(workspace, "../outside.json")).rejects.toThrow("inside the workspace")
        // A write-through escape (existing link + missing tail) is now rejected
        // by the containment layer itself, before any parent-directory walk.
        await expect(BrowserExport.fileTarget(workspace, "escape/created/outside.json")).rejects.toThrow(
          /inside the workspace|unsafe/,
        )
        const realWorkspace = await fs.realpath(workspace)
        const file = await BrowserExport.fileTarget(workspace, "nested/report.json")
        expect(file).toBe(path.join(realWorkspace, "nested", "report.json"))
        expect(
          await fs
            .stat(path.dirname(file))
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
      } finally {
        await Promise.all([
          fs.rm(workspace, { recursive: true, force: true }),
          fs.rm(outside, { recursive: true, force: true }),
        ])
      }
    }))
})

function owner(scopeID: string, sessionID: string): BrowserOwner.Info {
  return { mode: "session", scopeID, sessionID, directory: "/tmp/workspace" }
}

afterRuntimeTests(() => runtime.close())
