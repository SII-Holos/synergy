import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { app, BrowserWindow, safeStorage } from "electron"
import { DatabaseSync } from "node:sqlite"
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { BrowserImportSources } from "../../src/browser-import-sources"
import { BrowserDataActions } from "../../src/browser-data-actions"
import { BrowserDataStore } from "../../src/browser-data-store"

void run()
  .then(() => app.exit(0))
  .catch((error) => {
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
  const cookies = new DatabaseSync(path.join(profile, "Cookies"))
  cookies.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT)",
  )
  const expiration = BigInt(Date.now() + 86_400_000) * 1000n + 11_644_473_600_000_000n + 123n
  cookies
    .prepare("INSERT INTO cookies VALUES (?, ?, '', ?, '/', ?, 1, 1, 1, '')")
    .run(
      "example.test",
      "login",
      encrypt(Buffer.concat([createHash("sha256").update("example.test").digest(), Buffer.from("fixture-cookie")])),
      expiration,
    )
  login.close()
  cookies.close()
  const owner = spawn(
    process.execPath,
    [
      "-e",
      `
    const {DatabaseSync}=require("node:sqlite")
    const databases=process.argv.slice(1).map(file=>new DatabaseSync(file))
    for(const db of databases) db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT")
    console.log("ready")
    process.stdin.resume()
    process.stdin.on("end",()=>{for(const db of databases) db.close()})
  `,
      path.join(profile, "Login Data"),
      path.join(profile, "Cookies"),
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  const exited = once(owner, "exit")
  try {
    await once(owner.stdout, "data")
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
    const base = { protocolVersion: BROWSER_PROTOCOL_VERSION, ownerKey: "fixture", pageId: "one" }
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
    assert(Math.abs(saved.expirationDate! - Number(expiration - 11_644_473_600_000_000n) / 1_000_000) < 0.00001)
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
    for (const name of ["Login Data", "Cookies"]) {
      const live = new DatabaseSync(path.join(profile, name), { readOnly: true })
      try {
        assert.throws(() => live.prepare("SELECT count(*) FROM sqlite_master").all(), /locked/)
      } finally {
        live.close()
      }
    }
    assert.equal(owner.exitCode, null)
    window.destroy()
  } finally {
    owner.stdin.end()
    await exited
  }
}
