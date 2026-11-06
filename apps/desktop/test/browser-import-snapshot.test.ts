import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readBrowserSnapshot } from "../src/browser-import-snapshot"
import { browserImportFailure, createBrowserImportLogger } from "../src/browser-import-diagnostics"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "synergy-import-snapshot-test-"))
  roots.push(root)
  const file = path.join(root, "source")
  const db = new Database(file)
  db.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('committed')")
  db.close()
  const snapshots: string[] = []
  const input = {
    file,
    signal: new AbortController().signal,
    validate: async (_file: string) => {},
    openDatabase: async (copy: string) => {
      snapshots.push(path.dirname(copy))
      expect((await stat(path.dirname(copy))).mode & 0o777).toBe(0o700)
      expect((await stat(copy)).mode & 0o777).toBe(0o600)
      return new Database(copy)
    },
    read: async (copy: { prepare(sql: string): { all(): unknown[] } }) => copy.prepare("SELECT * FROM fixture").all(),
  }
  return { root, file, input, snapshots }
}

test("includes committed WAL data and removes private snapshots after reading", async () => {
  const f = await fixture()
  const owner = new Database(f.file)
  owner.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO fixture VALUES ('in-wal')")
  try {
    const before = await readFile(f.file + "-wal")
    expect(await readBrowserSnapshot(f.input)).toEqual([{ value: "committed" }, { value: "in-wal" }])
    expect(await readFile(f.file + "-wal")).toEqual(before)
    for (const snapshot of f.snapshots) expect(await stat(snapshot).catch(() => undefined)).toBeUndefined()
  } finally {
    owner.close()
  }
})

test("recovers an uncommitted rollback journal only inside the private copy", async () => {
  const f = await fixture()
  const owner = new Database(f.file)
  owner.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; BEGIN EXCLUSIVE")
  owner.exec("UPDATE fixture SET value = 'uncommitted'; CREATE TABLE overflow (data BLOB)")
  owner.exec("INSERT INTO overflow SELECT zeroblob(400000)")
  try {
    const before = await readFile(f.file)
    const journal = await readFile(f.file + "-journal")
    expect(await readBrowserSnapshot(f.input)).toEqual([{ value: "committed" }])
    expect(await readFile(f.file)).toEqual(before)
    expect(await readFile(f.file + "-journal")).toEqual(journal)
    expect(owner.query("SELECT value FROM fixture").get()).toEqual({ value: "uncommitted" })
  } finally {
    owner.exec("ROLLBACK")
    owner.close()
  }
})

test("refuses a changing source after bounded retries without returning partial rows", async () => {
  const f = await fixture()
  let mutations = 0
  f.input.validate = async () => {
    const db = new Database(f.file)
    db.prepare("INSERT INTO fixture VALUES (?)").run(String(++mutations))
    db.close()
  }
  await expect(readBrowserSnapshot(f.input)).rejects.toMatchObject({ code: "busy", stage: "snapshot", attempt: 3 })
  expect(f.snapshots).toEqual([])
})

test("rejects corrupt data, oversized sidecars and symlink sidecars without exposing content", async () => {
  const f = await fixture()
  await writeFile(f.file, "fixture-private-payload")
  await expect(readBrowserSnapshot(f.input)).rejects.toMatchObject({ code: "corrupt", stage: "integrity" })
  for (const snapshot of f.snapshots) expect(await stat(snapshot).catch(() => undefined)).toBeUndefined()
  await writeFile(f.file + "-wal", "")
  await truncate(f.file + "-wal", 128 * 1024 * 1024 + 1)
  await expect(readBrowserSnapshot(f.input)).rejects.toMatchObject({ code: "limit", stage: "snapshot" })
  await rm(f.file + "-wal")
  await symlink(f.file, f.file + "-wal")
  await expect(readBrowserSnapshot(f.input)).rejects.toMatchObject({ code: "unavailable", stage: "snapshot" })
})

test("cancellation and query failure remove the snapshot and keep the source unchanged", async () => {
  const f = await fixture()
  const before = await readFile(f.file)
  const controller = new AbortController()
  f.input.signal = controller.signal
  const openDatabase = f.input.openDatabase
  f.input.openDatabase = async (copy) => {
    const db = await openDatabase(copy)
    controller.abort()
    return db
  }
  await expect(readBrowserSnapshot(f.input)).rejects.toThrow()
  f.input.signal = new AbortController().signal
  f.input.openDatabase = openDatabase
  f.input.read = async () => {
    throw new Error("query-private-payload")
  }
  await expect(readBrowserSnapshot(f.input)).rejects.toMatchObject({ code: "unavailable", stage: "query" })
  for (const snapshot of f.snapshots) expect(await stat(snapshot).catch(() => undefined)).toBeUndefined()
  expect(await readFile(f.file)).toEqual(before)
})

test("diagnostics retain fixed error categories and numeric SQLite codes without raw exceptions or paths", async () => {
  const f = await fixture()
  const failure = browserImportFailure(
    Object.assign(new Error("credential-private-payload"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
    "snapshot",
  )
  const log = createBrowserImportLogger(f.root)
  await log({
    browser: "chrome",
    kind: "passwords",
    stage: failure.stage,
    error: failure.code,
    sqliteCode: failure.sqliteCode,
    attempt: 3,
  })
  const text = await readFile(path.join(f.root, "browser-import.log"), "utf8")
  expect(JSON.parse(text)).toMatchObject({
    browser: "chrome",
    kind: "passwords",
    stage: "snapshot",
    error: "busy",
    sqliteCode: 5,
    attempt: 3,
  })
  expect(text).not.toContain("private-payload")
  expect(text).not.toContain(f.root)
  expect((await stat(path.join(f.root, "browser-import.log"))).mode & 0o777).toBe(0o600)
  expect(browserImportFailure({ code: "EACCES" }, "snapshot").code).toBe("access")
  expect(browserImportFailure({ code: "SQLITE_ERROR" }, "query").code).toBe("unsupported")
})
