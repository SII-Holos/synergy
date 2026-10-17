import { app, session, safeStorage, webContents } from "electron"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { BROWSER_PROTOCOL_VERSION, BrowserProfileDataRequestSchema } from "@ericsanchezok/synergy-browser-core"
import { BrowserDataContexts } from "../../src/browser-data-contexts"
import { BrowserDataActions } from "../../src/browser-data-actions"
import { BrowserDataStore } from "../../src/browser-data-store"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
async function run() {
  await app.whenReady()
  const baseline = webContents.getAllWebContents().length
  assert.equal(baseline, 0)
  const partition = `persist:synergy-browser-fixture-${randomUUID()}`
  const contexts = new BrowserDataContexts({ session: (partition) => session.fromPartition(partition) })
  const contextId = randomUUID(),
    epoch = randomUUID(),
    ownerKey = "scope:home:scope"
  contexts.prepare({
    contextId,
    epoch,
    ownerKey,
    expiresAt: Date.now() + 15 * 60_000,
    profile: { id: "personal", revision: 1, partition },
  })
  const store = new BrowserDataStore(path.join(app.getPath("userData"), "browser-data"), {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
  })
  const files = {
    passwords: path.join(app.getPath("userData"), "passwords.csv"),
    cookies: path.join(app.getPath("userData"), "cookies.json"),
  }
  await writeFile(files.passwords, "url,username,password\nhttps://fixture.test,fixture-account,fixture-secret\n")
  await writeFile(
    files.cookies,
    JSON.stringify([
      { name: "login", value: "fixture-cookie", domain: "fixture.test", path: "/", secure: true, httpOnly: true },
    ]),
  )
  let pageTargets = 0
  const actions = new BrowserDataActions({
    store,
    target: () => {
      pageTargets++
      throw new Error("No page exists")
    },
    profileTarget: (id) => contexts.target(id),
    closeProfileContext: (id) => contexts.close(id),
    chooseFile: async (kind) => files[kind],
  })
  const base = { protocolVersion: BROWSER_PROTOCOL_VERSION, contextId }
  for (const action of [{ type: "saveLogin" }, { type: "fillLogin", id: "fixture-login" }])
    assert.equal(BrowserProfileDataRequestSchema.safeParse({ ...base, action }).success, false)
  assert.equal(
    BrowserProfileDataRequestSchema.safeParse({ ...base, partition, action: { type: "state" } }).success,
    false,
  )
  const result = await actions.executeProfile({
    ...base,
    action: {
      type: "import",
      sourceId: "file",
      kinds: ["passwords", "cookies"],
      requestId: "native-fixture",
      overwrite: false,
    },
  })
  assert.equal(result.type, "import")
  if (result.type !== "import") throw new Error("Import result is missing")
  assert.equal(result.imported, 2)
  assert.equal(result.failed, 0)
  const state = await actions.executeProfile({ ...base, action: { type: "state" } })
  assert.equal(state.type, "state")
  if (state.type !== "state") throw new Error("Metadata is missing")
  assert.equal(state.passwords.length, 1)
  assert.equal(state.passwords[0]!.username, "fixture-account")
  assert(!/fixture-secret|fixture-cookie|partition|encrypted/.test(JSON.stringify([state, result])))
  assert(!(await readFile(store.file(partition), "utf8")).includes("fixture-secret"))
  assert.equal((await session.fromPartition(partition).cookies.get({ name: "login" }))[0]!.value, "fixture-cookie")
  assert.equal(webContents.getAllWebContents().length, baseline)
  assert.equal(pageTargets, 0)
  await actions.executeProfile({ ...base, action: { type: "deletePassword", id: state.passwords[0]!.id } })
  assert.equal((await store.list(partition)).passwords.length, 0)
  await actions.executeProfile({ ...base, action: { type: "closeContext" } })
  await assert.rejects(actions.executeProfile({ ...base, action: { type: "state" } }))
  contexts.prepare({
    contextId: randomUUID(),
    epoch,
    ownerKey,
    expiresAt: Date.now() + 15 * 60_000,
    profile: { id: "personal", revision: 2, partition },
  })
  contexts.disconnect()
  await assert.rejects(actions.executeProfile({ ...base, action: { type: "state" } }))
  assert.equal(webContents.getAllWebContents().length, 0)
  console.log(
    "Profile data fixture passed: zero WebContents; password/cookie import; metadata only; deletion; close/disconnect revocation.",
  )
  await session.fromPartition(partition).clearStorageData()
  await store.clear(partition)
  app.exit(0)
}
