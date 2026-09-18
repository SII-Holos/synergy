import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageCompat } from "../../src/storage/compat"
import { SessionCompat, registerSessionReplays } from "../../src/session/compat-import"

const scopeID = Identifier.asScopeID("home")
const VALID = "ses_test000000000000000valid"
const CORRUPT = "ses_test0000000000000corrupt"
const sid = Identifier.asSessionID(VALID)
const corruptID = Identifier.asSessionID(CORRUPT)

async function writeHome(relative: string, value: unknown) {
  const file = path.join(Global.Path.data, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value))
}

async function compatFixture() {
  await fs.writeFile(
    path.join(Global.Path.root, "data", "storage", "manifest.json"),
    JSON.stringify({ version: 1, compatBoundary: StorageCompat.boundary }),
  )
  await writeHome(`sessions/home/${VALID}/info.json`, {
    id: VALID,
    scope: { id: "home", type: "home", directory: "/tmp/compat-fixture" },
    title: "legacy session",
    version: "3.0.22",
    time: { created: 1000, updated: 2000 },
    controlProfile: "guarded",
    completionNotice: { unread: false, silent: false, unreadCount: 0 },
  })
  await writeHome(`sessions/home/${VALID}/messages/msg_legacy/info.json`, {
    id: "msg_legacy",
    sessionID: VALID,
    role: "user",
    time: { created: 1500 },
    agent: "synergy",
    isRoot: true,
    visible: true,
    includeInContext: true,
    origin: { type: "user" },
  })
  await writeHome(`sessions/home/${CORRUPT}/info.json`, "{invalid json")
  await StorageCompat.seedLocators(Storage.current().store, Global.Path.data)
}

test("a deferred aggregate imports on touch, replays migrations, and leaves no JSON", async () => {
  await compatFixture()
  const replayed: string[] = []
  registerSessionReplays([{ id: "test-observer", run: async () => void replayed.push("ran") }])

  const before = await StorageCompat.pendingLocators(Storage.current().store)
  expect(before.map((locator) => locator.sessionID).sort()).toEqual([CORRUPT, VALID].sort())

  const locator = await SessionCompat.requireImported(VALID)
  expect(locator.status).toBe("imported")
  expect(replayed).toEqual(["ran"])

  expect(await Storage.read(StoragePath.sessionInfo(scopeID, sid))).toMatchObject({ title: "legacy session" })
  expect(await Storage.read(StoragePath.sessionIndex(sid))).toMatchObject({ scopeID: "home" })
  expect(await Storage.read(StoragePath.messageInfo(scopeID, sid, Identifier.asMessageID("msg_legacy")))).toMatchObject(
    { role: "user" },
  )
  expect(await Bun.file(path.join(Global.Path.data, `sessions/home/${VALID}/info.json`)).exists()).toBe(false)

  // The unreadable corrupt aggregate stays invisible to listings until a touch quarantines it.
  const page = await SessionCompat.mergePageIndex("home", { entries: [] })
  expect(page.entries).toEqual([])

  await expect(SessionCompat.requireImported(CORRUPT)).rejects.toThrow("quarantined historical data")
  const [recovery] = await Storage.readMany<{ blocked: boolean }>([["storage_recovery", "sessions", CORRUPT, "info"]])
  expect(recovery?.blocked).toBe(true)

  const stats = await SessionCompat.stats()
  expect(stats).toMatchObject({ imported: 1, quarantined: 1, pending: 0, partial: 0 })

  await StorageCompat.rejectForeignWriters(Global.Path.data, Storage.current().store)
})
