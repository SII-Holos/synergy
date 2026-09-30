import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BrowserImportSources } from "../src/browser-import-sources"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const key = Buffer.from("disposable-import-fixture")
function encrypted(value: Buffer | string) {
  const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync(key, "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 32))
  return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()])
}
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "synergy-import-source-"))
  roots.push(home)
  const chrome = path.join(home, "Library/Application Support/Google/Chrome")
  const profile = path.join(chrome, "Default")
  await mkdir(profile, { recursive: true })
  await writeFile(
    path.join(chrome, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Work" } } } }),
  )
  const passwords = new Database(path.join(profile, "Login Data"))
  passwords.exec(
    "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)",
  )
  passwords
    .prepare("INSERT INTO logins VALUES (?, ?, ?, 0)")
    .run("https://example.test/login", "fixture", encrypted("fixture-password"))
  passwords.close()
  const cookies = new Database(path.join(profile, "Cookies"))
  cookies.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT)",
  )
  const add = cookies.prepare("INSERT INTO cookies VALUES (?, ?, '', ?, '/', 0, 1, 1, 1, ?)")
  add.run(
    "example.test",
    "session",
    encrypted(Buffer.concat([createHash("sha256").update("example.test").digest(), Buffer.from("fixture-cookie")])),
    "",
  )
  add.run(
    "wrong.test",
    "tampered",
    encrypted(Buffer.concat([createHash("sha256").update("example.test").digest(), Buffer.from("fixture-cookie")])),
    "",
  )
  add.run(
    "example.test",
    "partitioned",
    encrypted(Buffer.concat([createHash("sha256").update("example.test").digest(), Buffer.from("fixture-cookie")])),
    "https://top.test",
  )
  cookies.close()
  let authorizations = 0
  const sources = new BrowserImportSources({
    home,
    platform: "darwin",
    readKey: async () => {
      authorizations++
      return Buffer.from(key)
    },
    openDatabase: async (file) => new Database(file, { readonly: true }),
  })
  return { sources, profile, chrome, home, authorizations: () => authorizations }
}

test("source discovery returns only profile metadata and never unlocks credentials", async () => {
  const f = await fixture()
  const sources = await f.sources.list()
  expect(sources).toContainEqual(
    expect.objectContaining({ browser: "chrome", profile: "Work", mode: "direct", kinds: ["passwords", "cookies"] }),
  )
  expect(sources).toContainEqual(expect.objectContaining({ browser: "safari", mode: "file", kinds: ["passwords"] }))
  expect(JSON.stringify(sources)).not.toContain(f.home)
  expect(JSON.stringify(sources)).not.toContain("fixture-password")
  expect(f.authorizations()).toBe(0)
})

test("explicit native import reads both types once, verifies cookie binding and preserves partition keys", async () => {
  const f = await fixture()
  const source = (await f.sources.list()).find((s) => s.browser === "chrome")!
  const batches = await f.sources.read(source.id, ["passwords", "cookies"], new AbortController().signal)
  expect(batches[0]).toMatchObject({
    kind: "passwords",
    failed: 0,
    rows: [{ origin: "https://example.test/login", username: "fixture", password: "fixture-password" }],
  })
  expect(batches[1]).toMatchObject({
    kind: "cookies",
    failed: 1,
    rows: [
      { domain: "example.test", value: "fixture-cookie", expires: -1, sameSite: "Lax" },
      { partitionKey: "https://top.test" },
    ],
  })
  expect(f.authorizations()).toBe(1)
  const original = new Database(path.join(f.profile, "Login Data"), { readonly: true })
  expect(original.prepare("SELECT count(*) AS count FROM logins").get()).toEqual({ count: 1 })
  original.close()
})

test("unknown sources, path escapes and cancelled reads cannot request credentials", async () => {
  const f = await fixture()
  await writeFile(
    path.join(f.chrome, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: { "../../escape": { name: "Escape" }, "Profile 1": { name: "Link" }, Default: { name: "Work" } },
      },
    }),
  )
  await symlink(f.profile, path.join(f.chrome, "Profile 1"))
  const sources = await f.sources.list()
  expect(sources.filter((s) => s.browser === "chrome")).toHaveLength(1)
  await expect(f.sources.read("unknown", ["passwords"], new AbortController().signal)).rejects.toThrow()
  const abort = new AbortController()
  abort.abort()
  await expect(f.sources.read(sources[0]!.id, ["passwords"], abort.signal)).rejects.toThrow()
  expect(f.authorizations()).toBe(0)
})

test("unsupported encryption is rejected and OS failures disclose no credential output", async () => {
  const f = await fixture()
  const db = new Database(path.join(f.profile, "Login Data"))
  db.prepare("UPDATE logins SET password_value = ?").run(Buffer.from("v20-do-not-copy-as-plaintext"))
  db.close()
  const source = (await f.sources.list()).find((s) => s.browser === "chrome")!
  expect(await f.sources.read(source.id, ["passwords"], new AbortController().signal)).toMatchObject([
    { failed: 1, rows: [] },
  ])
  const denied = new BrowserImportSources({
    home: f.home,
    platform: "darwin",
    readKey: async () => {
      throw new Error("secret output")
    },
    openDatabase: async (file) => new Database(file, { readonly: true }),
  })
  const selected = (await denied.list()).find((s) => s.browser === "chrome")!
  await expect(denied.read(selected.id, ["passwords"], new AbortController().signal)).rejects.toThrow(
    "Browser access was not granted",
  )
})

test("platforms without native import offer explicit file sources", async () => {
  const f = await fixture()
  const sources = new BrowserImportSources({ home: f.home, platform: "win32" })
  expect(await sources.list()).toEqual([{ id: "file", browser: "file", mode: "file", kinds: ["passwords", "cookies"] }])
})

test("account password databases are included and excessive source rows are refused", async () => {
  const f = await fixture()
  const account = new Database(path.join(f.profile, "Login Data For Account"))
  account.exec(
    "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)",
  )
  account
    .prepare("INSERT INTO logins VALUES (?, ?, ?, 0)")
    .run("https://account.test", "account", encrypted("account-fixture"))
  account.close()
  const source = (await f.sources.list()).find((source) => source.browser === "chrome")!
  expect(await f.sources.read(source.id, ["passwords"], new AbortController().signal)).toMatchObject([
    { rows: [{ username: "fixture" }, { username: "account" }] },
  ])
  const local = new Database(path.join(f.profile, "Login Data"))
  local.exec(
    "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<10001) INSERT INTO logins SELECT 'https://example.test','fixture',x'00',0 FROM seq",
  )
  local.close()
  const result = await f.sources.read(source.id, ["passwords"], new AbortController().signal)
  expect(result[0]).toMatchObject({ error: "unavailable", rows: [{ username: "account" }] })
})

test("cancellation while OS access is pending never opens a source database", async () => {
  const f = await fixture()
  const abort = new AbortController()
  let reads = 0
  const sources = new BrowserImportSources({
    home: f.home,
    platform: "darwin",
    readKey: async () => {
      abort.abort()
      return Buffer.from(key)
    },
    openDatabase: async (file) => {
      reads++
      return new Database(file, { readonly: true })
    },
  })
  const source = (await sources.list()).find((source) => source.browser === "chrome")!
  await expect(sources.read(source.id, ["passwords"], abort.signal)).rejects.toThrow()
  expect(reads).toBe(0)
})
