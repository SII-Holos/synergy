import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { describe, expect, test } from "bun:test"
import { BrowserMigration } from "../src/migration.js"
import { BrowserStorage } from "../src/storage.js"
import type { BrowserOwner } from "../src/owner.js"

describe("BrowserMigration", () => {
  test("upgrades legacy multi-page state to one suspended v4 descriptor without obsolete path fields", async () => {
    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: `scope-browser-migration-${Date.now()}`,
      directory: process.cwd(),
      sessionID: "session-a",
    }
    const legacyStatePath = ["browser", "sessions", owner.scopeID, "session", owner.sessionID!]
    const statePath = BrowserStorage.keyForOwner(owner)
    await Storage.write(legacyStatePath, {
      tabs: [
        {
          id: "page-1",
          url: "https://example.com/path?q=1#hash",
          title: "Example",
          order: 0,
        },
      ],
      activeTabID: "missing-page",
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
    })

    const result = await BrowserMigration.run(owner)
    const upgraded = await Storage.read<{
      version: number
      status: string
      page: { id: string; [key: string]: unknown }
      [key: string]: unknown
    }>(statePath)

    expect(result.changed).toBe(true)
    expect(result.version).toBe(BrowserStorage.CURRENT_VERSION)
    expect(upgraded.version).toBe(BrowserStorage.CURRENT_VERSION)
    expect(upgraded.status).toBe("suspended")
    expect(upgraded.page).toEqual({
      id: "page-1",
      url: "https://example.com/path?q=1#hash",
      title: "Example",
      lastActiveAt: null,
    })
    expect(upgraded.tabs).toBeUndefined()
    expect(upgraded.activeTabID).toBeUndefined()
    expect(upgraded.storageStatePath).toBeUndefined()
    expect(upgraded.profileDir).toBeUndefined()
    expect(upgraded.annotations).toEqual([
      {
        id: "ann-1",
        pageID: "page-1",
        pageURL: "https://example.com/path?q=1#hash",
        comment: "keep this",
        resolved: false,
        createdAt: 1,
      },
    ])
    expect(upgraded.checkpoint).toEqual({
      url: "https://example.com/path?q=1#hash",
      cookies: [],
      origins: [],
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 0 },
      formState: [],
    })
    expect(await Storage.readMany([legacyStatePath])).toEqual([undefined])

    await Storage.remove(statePath)
  })

  test("preserves a recoverable failed descriptor with a structured error", async () => {
    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: `scope-browser-failed-migration-${Date.now()}`,
      directory: process.cwd(),
      sessionID: "session-failed",
    }
    const statePath = BrowserStorage.keyForOwner(owner)
    await Storage.write(statePath, {
      version: 4,
      status: "failed",
      page: { id: "page-failed", url: "https://example.com/", title: "Example", lastActiveAt: 1 },
      timestamp: 1,
      error: "Host restore failed",
    })

    await BrowserMigration.run(owner)
    const upgraded = await Storage.read<{
      version: number
      status: string
      page: { id: string; [key: string]: unknown }
      [key: string]: unknown
    }>(statePath)
    expect(upgraded.status).toBe("failed")
    expect(upgraded.page.id).toBe("page-failed")
    expect(upgraded.error).toEqual({
      type: "error",
      code: "browser_migrated_failure",
      message: "Host restore failed",
      retryable: true,
      suggestedAction: "Resume the Browser page to retry recovery.",
    })
  })

  test("rejects traversal-shaped legacy owner identifiers", async () => {
    await expect(
      BrowserMigration.run({
        mode: "session",
        scopeID: "../../outside",
        directory: process.cwd(),
        sessionID: "session",
      }),
    ).rejects.toThrow("Legacy Browser scope identifier is unsafe")
  })
})
