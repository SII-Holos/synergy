import { afterAll, expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { BrowserMigration } from "../src/migration"
import { BrowserOwner } from "../src/owner"
import { BrowserProfiles } from "../src/profiles"
import { BrowserStorage } from "../src/storage"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()
afterAll(() => runtime.close())
const owner = (id: string) => ({ mode: "session" as const, scopeID: "migration", sessionID: id, directory: null })
test("fresh migration allocates no pages", () =>
  runtime.run(async () => {
    await BrowserMigration.runAll()
    expect(await BrowserStorage.load(owner("fresh"))).toBeNull()
  }))
test("v4 owners become separate legacy identities with exact partitions; reruns preserve newer pages", () =>
  runtime.run(async () => {
    for (const id of ["one", "two"]) {
      const target = owner(id),
        digest = BrowserOwner.storageID(target)
      await Storage.write(["browser", "sessions-v4", digest], {
        version: 4,
        status: "active",
        page: { id: "page-" + id, url: "https://example.com/", title: id, lastActiveAt: 1 },
        checkpoint: { cookies: [{ name: "fixture" }] },
        timestamp: 1,
      })
    }
    await BrowserMigration.runAll()
    const first = (await BrowserStorage.load(owner("one")))!,
      second = (await BrowserStorage.load(owner("two")))!
    expect(first.version).toBe(5)
    expect(first.pages[0]?.status).toBe("suspended")
    expect(first.pages[0]?.profileId).not.toBe(second.pages[0]?.profileId)
    expect((await BrowserProfiles.get(first.pages[0]!.profileId)).partition).toBe(
      `persist:synergy-browser-${BrowserOwner.storageID(owner("one"))}`,
    )
    expect(first).not.toHaveProperty("checkpoint")
    await BrowserStorage.save(owner("one"), { ...first, pages: [], timestamp: 2 })
    await BrowserMigration.runAll()
    expect((await BrowserStorage.load(owner("one")))?.pages).toEqual([])
    expect(
      (await Storage.readMany([["browser", "sessions-v4", BrowserOwner.storageID(owner("one"))]]))[0],
    ).toBeDefined()
  }))
test("legacy annotations migrate while execution checkpoints stay retired", () =>
  runtime.run(async () => {
    const target = owner("legacy"),
      key = ["browser", "sessions", target.scopeID, "session", target.sessionID]
    await Storage.write(key, {
      tabs: [{ id: "page", url: "https://example.com", title: "Legacy" }],
      timestamp: 1,
      annotations: [
        { id: "a", pageID: "page", tabURL: "https://example.com", comment: "Review", resolved: false, createdAt: 1 },
      ],
    })
    expect((await BrowserMigration.run(target)).changed).toBe(true)
    expect((await BrowserStorage.load(target))?.annotations?.[0]).toMatchObject({
      pageURL: "https://example.com",
      comment: "Review",
    })
    expect((await BrowserMigration.run(target)).changed).toBe(false)
  }))
test("unsafe legacy identifiers are rejected before storage access", () =>
  runtime.run(async () => {
    await expect(BrowserMigration.run({ ...owner("unsafe"), scopeID: "../../outside" })).rejects.toThrow("unsafe")
  }))
