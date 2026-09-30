import { app, BrowserWindow, safeStorage } from "electron"
import { DatabaseSync } from "node:sqlite"
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { BrowserImportSources } from "../../src/browser-import-sources"
import { BrowserDataActions } from "../../src/browser-data-actions"
import { BrowserDataStore } from "../../src/browser-data-store"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
async function run() {
  await app.whenReady()
  const home = path.join(app.getPath("userData"), "import-fixture")
  const root = path.join(home, "Library/Application Support/Google/Chrome")
  const profile = path.join(root, "Default")
  await mkdir(profile, { recursive: true })
  await writeFile(
    path.join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Test" } } } }),
  )
  const secret = Buffer.from("isolated-fixture-key")
  const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1")
  const encrypt = (value: Buffer | string) => {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32))
    return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()])
  }
  const login = new DatabaseSync(path.join(profile, "Login Data"))
  login.exec(
    "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)",
  )
  login
    .prepare("INSERT INTO logins VALUES (?, ?, ?, 0)")
    .run("https://example.test", "fixture", encrypt("fixture-secret"))
  login.close()
  const cookies = new DatabaseSync(path.join(profile, "Cookies"))
  cookies.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT)",
  )
  cookies
    .prepare("INSERT INTO cookies VALUES (?, ?, '', ?, '/', 0, 1, 1, 1, '')")
    .run(
      "example.test",
      "login",
      encrypt(Buffer.concat([createHash("sha256").update("example.test").digest(), Buffer.from("fixture-cookie")])),
    )
  cookies.close()
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: "persist:import-fixture",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  await window.loadURL("about:blank")
  let authorizations = 0
  const sources = new BrowserImportSources({
    home,
    platform: "darwin",
    readKey: async () => {
      authorizations++
      return Buffer.from(secret)
    },
  })
  const store = new BrowserDataStore(path.join(app.getPath("userData"), "browser-data"), {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
  })
  const actions = new BrowserDataActions({
    sources,
    store,
    target: () => ({ partition: "persist:import-fixture", contents: window.webContents }),
    chooseFile: async () => undefined,
  })
  const base = { protocolVersion: 4 as const, ownerKey: "fixture", pageId: "one" }
  const catalog = await actions.execute({ ...base, action: { type: "importSources" } })
  assert.equal(authorizations, 0)
  assert.equal(catalog.type, "sources")
  if (catalog.type !== "sources") throw new Error("Missing sources")
  const source = catalog.sources.find((source) => source.browser === "chrome")!
  const request = {
    type: "import" as const,
    sourceId: source.id,
    kinds: ["passwords", "cookies"] as ("passwords" | "cookies")[],
    overwrite: false,
    requestId: "fixture-import",
  }
  const result = await actions.execute({ ...base, action: request })
  assert.equal(result.type, "import")
  if (result.type !== "import") throw new Error("Missing result")
  assert.equal(result.imported, 2)
  assert.equal(result.failed, 0)
  assert.equal(authorizations, 1)
  assert(!JSON.stringify(result).includes("fixture-secret"))
  const saved = (await window.webContents.session.cookies.get({ name: "login" }))[0]!
  assert.equal(saved.hostOnly, true)
  assert.equal(saved.httpOnly, true)
  assert.equal(saved.sameSite, "lax")
  assert.equal(saved.value, "fixture-cookie")
  const state = await store.list("persist:import-fixture")
  assert.equal(state.passwords.length, 1)
  assert(!(await readFile(store.file("persist:import-fixture"), "utf8")).includes("fixture-secret"))
  assert.equal(
    (await store.password("persist:import-fixture", state.passwords[0]!.id, "https://example.test"))?.password,
    "fixture-secret",
  )
  const repeated = await actions.execute({ ...base, action: { ...request, requestId: "repeat" } })
  assert.equal(repeated.type, "import")
  if (repeated.type === "import") {
    assert.equal(repeated.imported, 0)
    assert.equal(repeated.skipped, 2)
  }
  window.destroy()
  app.exit(0)
}
