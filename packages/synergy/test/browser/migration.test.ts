import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { BrowserMigration } from "../../src/browser/migration.js"
import { BrowserStorage } from "../../src/browser/storage.js"
import { Global } from "../../src/global/index.js"
import type { BrowserOwner } from "../../src/browser/owner.js"

describe("BrowserMigration", () => {
  test("upgrades legacy multi-page session state to v3 single-page storage", async () => {
    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: `scope-browser-migration-${Date.now()}`,
      directory: process.cwd(),
      sessionID: "session-a",
    }
    const statePath = BrowserStorage.pathForOwner(owner)
    await fs.mkdir(path.dirname(statePath), { recursive: true })
    await Bun.write(
      statePath,
      JSON.stringify(
        {
          tabs: [
            {
              id: "page-1",
              url: "https://example.com/path?q=1#hash",
              title: "Example",
              order: 0,
            },
          ],
          activeTabID: "missing-tab",
          timestamp: 1,
          annotations: [
            {
              id: "ann-1",
              pageID: "page-1",
              tabURL: "https://example.com/path?q=1#hash",
              comment: "keep this",
              resolved: false,
              createdAt: 1,
            },
          ],
        },
        null,
        2,
      ),
    )

    const result = await BrowserMigration.run(owner)
    const upgraded = JSON.parse(await Bun.file(statePath).text())
    const storageState = JSON.parse(await Bun.file(BrowserStorage.storageStatePath(owner)).text())

    expect(result.changed).toBe(true)
    expect(result.version).toBe(BrowserStorage.CURRENT_VERSION)
    expect(upgraded.version).toBe(BrowserStorage.CURRENT_VERSION)
    expect(upgraded.page).toBeNull()
    expect(upgraded.tabs).toBeUndefined()
    expect(upgraded.activeTabID).toBeUndefined()
    expect(upgraded.storageStatePath).toBe(BrowserStorage.storageStatePath(owner))
    expect(upgraded.profileDir).toBe(BrowserStorage.profileDir(owner))
    expect(upgraded.annotations).toEqual([])
    expect(storageState).toEqual({ cookies: [], origins: [] })

    await fs.rm(path.join(Global.Path.data, "browser", "sessions", owner.scopeID), { recursive: true, force: true })
    await fs.rm(BrowserStorage.profileDir(owner), { recursive: true, force: true })
  })
})
