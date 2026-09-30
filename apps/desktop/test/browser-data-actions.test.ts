import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zipSync, strToU8 } from "fflate"
import { BrowserDataStore } from "../src/browser-data-store"
import { BrowserDataActions, readBrowserImport } from "../src/browser-data-actions"
import { BrowserImportSources } from "../src/browser-import-sources"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "synergy-browser-import-"))
  roots.push(root)
  return root
}
const request = { protocolVersion: 4 as const, ownerKey: "owner", pageId: "page" }
const encryption = {
  available: async () => true,
  encrypt: async (text: string) => Buffer.from(text).reverse(),
  decrypt: async (data: Buffer) => Buffer.from(data).reverse().toString(),
}

test("imports valid rows while retaining existing accounts and reporting no secrets", async () => {
  const root = await fixture(),
    file = path.join(root, "passwords.csv")
  await writeFile(
    file,
    "url,username,password\nhttps://example.com,a,fixture-secret\ninvalid,b,do-not-report\nhttps://example.com,a,replacement\n",
  )
  const store = new BrowserDataStore(root, encryption)
  const contents = {} as Electron.WebContents
  const actions = new BrowserDataActions({
    store,
    target: () => ({ partition: "persist:one", contents }),
    chooseFile: async () => file,
  })
  const result = await actions.execute({
    ...request,
    action: { type: "import", sourceId: "file", kinds: ["passwords"], overwrite: false, requestId: "import-one" },
  })
  expect(result).toMatchObject({ imported: 1, skipped: 1, failed: 1, cancelled: false })
  expect(JSON.stringify(result)).not.toContain("do-not-report")
  expect((await store.list("persist:one")).passwords).toHaveLength(1)
})

test("cancellation stops remaining rows and accurately retains completed writes", async () => {
  const root = await fixture(),
    file = path.join(root, "passwords.csv")
  await writeFile(file, "url,username,password\nhttps://one.example,a,one\nhttps://two.example,b,two\n")
  let unblock!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const store = new BrowserDataStore(root, {
    ...encryption,
    encrypt: async (text) => {
      entered()
      await blocked
      return encryption.encrypt(text)
    },
  })
  const contents = {} as Electron.WebContents
  const actions = new BrowserDataActions({
    store,
    target: () => ({ partition: "persist:one", contents }),
    chooseFile: async () => file,
  })
  const pending = actions.execute({
    ...request,
    action: { type: "import", sourceId: "file", kinds: ["passwords"], overwrite: false, requestId: "job" },
  })
  await started
  await actions.execute({ ...request, action: { type: "cancelImport", requestId: "job" } })
  unblock()
  expect(await pending).toMatchObject({ imported: 1, cancelled: true })
  expect((await store.list("persist:one")).passwords).toHaveLength(1)
})

test("Safari ZIP imports only its password CSV and rejects ambiguous archives", async () => {
  const root = await fixture(),
    file = path.join(root, "safari.zip")
  const csv = "URL,Username,Password\nhttps://example.com,u,p"
  await writeFile(file, zipSync({ "Passwords.csv": strToU8(csv), "PaymentCards.json": strToU8("private") }))
  expect(await readBrowserImport(file, "passwords")).toBe(csv)
  await writeFile(file, zipSync({ "密码.csv": strToU8(csv), "付款卡.csv": strToU8("Name,Number\nprivate,private") }))
  expect(await readBrowserImport(file, "passwords")).toBe(csv)
  await writeFile(file, zipSync({ "a/Passwords.csv": strToU8(csv), "b/Passwords.csv": strToU8(csv) }))
  await expect(readBrowserImport(file, "passwords")).rejects.toThrow()
})

test("one import reports each selected type and retains host-only cookie scope", async () => {
  const root = await fixture()
  const passwordFile = path.join(root, "passwords.csv"),
    cookieFile = path.join(root, "cookies.json")
  await writeFile(passwordFile, "url,username,password\nhttps://example.test,u,fixture")
  await writeFile(
    cookieFile,
    JSON.stringify([{ name: "session", value: "fixture", domain: "example.test", path: "/", secure: true }]),
  )
  const writes: unknown[] = []
  const contents = {
    session: {
      cookies: {
        get: async () => [],
        set: async (value: unknown) => {
          writes.push(value)
        },
        flushStore: async () => {},
      },
    },
  } as never
  const actions = new BrowserDataActions({
    store: new BrowserDataStore(root, encryption),
    target: () => ({ partition: "persist:one", contents }),
    chooseFile: async (kind) => (kind === "passwords" ? passwordFile : cookieFile),
  })
  const result = await actions.execute({
    ...request,
    action: { type: "import", sourceId: "file", kinds: ["passwords", "cookies"], overwrite: false, requestId: "both" },
  })
  expect(result).toMatchObject({
    imported: 2,
    items: [
      { kind: "passwords", imported: 1 },
      { kind: "cookies", imported: 1 },
    ],
  })
  expect(writes).toHaveLength(1)
  expect(writes[0]).not.toHaveProperty("domain")
  expect(JSON.stringify(result)).not.toContain("fixture")
})

test("partitioned cookies are reported unsupported instead of changing their isolation", async () => {
  const root = await fixture(),
    file = path.join(root, "cookies.json")
  await writeFile(
    file,
    JSON.stringify([
      { name: "session", value: "fixture", domain: "example.com", path: "/", partitionKey: "https://top.example" },
    ]),
  )
  let writes = 0
  const contents = {
    session: { cookies: { get: async () => [], set: async () => writes++, flushStore: async () => {} } },
  } as never
  const actions = new BrowserDataActions({
    store: new BrowserDataStore(root, encryption),
    target: () => ({ partition: "persist:one", contents }),
    chooseFile: async () => file,
  })
  expect(
    await actions.execute({
      ...request,
      action: { type: "import", sourceId: "file", kinds: ["cookies"], overwrite: false, requestId: "cookies" },
    }),
  ).toMatchObject({ imported: 0, failed: 1, issues: [{ row: 1, reason: "partitioned" }] })
  expect(writes).toBe(0)
})

test("password fill errors never forward page-controlled credential content", async () => {
  const root = await fixture()
  const store = new BrowserDataStore(root, encryption)
  await store.savePassword(
    "persist:one",
    { origin: "https://example.com", username: "u", password: "secret-fixture" },
    false,
  )
  const id = (await store.list("persist:one")).passwords[0]!.id
  const actions = new BrowserDataActions({
    store,
    target: () => ({
      partition: "persist:one",
      contents: {
        getURL: () => "https://example.com/login",
        executeJavaScript: async () => {
          throw new Error("secret-fixture")
        },
      } as never,
    }),
    chooseFile: async () => undefined,
  })
  await expect(actions.execute({ ...request, action: { type: "fillLogin", id } })).rejects.toThrow(
    "Could not fill this login",
  )
})

test("replacing the page during import stops remaining records and retains its result", async () => {
  const root = await fixture(),
    file = path.join(root, "passwords.csv")
  await writeFile(file, "url,username,password\nhttps://one.example,a,one\nhttps://two.example,b,two\n")
  const first = {} as Electron.WebContents
  let changed = false
  const store = new BrowserDataStore(root, {
    ...encryption,
    encrypt: async (value) => {
      changed = true
      return encryption.encrypt(value)
    },
  })
  const actions = new BrowserDataActions({
    store,
    target: () => ({ partition: "persist:one", contents: changed ? ({} as never) : first }),
    chooseFile: async () => file,
  })
  expect(
    await actions.execute({
      ...request,
      action: { type: "import", sourceId: "file", kinds: ["passwords"], overwrite: false, requestId: "change" },
    }),
  ).toMatchObject({ imported: 1, cancelled: true })
})

test("native read failures retain rejected record counts even when no rows can be imported", async () => {
  const root = await fixture()
  const contents = {} as Electron.WebContents
  const sources = new BrowserImportSources()
  sources.list = async () => [{ id: "chrome", browser: "chrome", mode: "direct", kinds: ["passwords"] }]
  sources.read = async () => [{ kind: "passwords", rows: [], failed: 2, error: "unavailable" }]
  const actions = new BrowserDataActions({
    store: new BrowserDataStore(root, encryption),
    target: () => ({ partition: "persist:one", contents }),
    chooseFile: async () => {
      throw new Error("Native imports must not open the file chooser.")
    },
    sources,
  })
  expect(
    await actions.execute({
      ...request,
      action: { type: "import", sourceId: "chrome", kinds: ["passwords"], overwrite: false, requestId: "partial" },
    }),
  ).toMatchObject({ failed: 2, items: [{ kind: "passwords", failed: 2, error: "unavailable" }] })
})
