import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BROWSER_PROTOCOL_VERSION, BrowserProfileDataRequestSchema } from "@ericsanchezok/synergy-browser-core"
import { BrowserDataContexts } from "../src/browser-data-contexts"
import { BrowserDataActions } from "../src/browser-data-actions"
import { BrowserDataStore } from "../src/browser-data-store"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "synergy-profile-data-"))
  roots.push(root)
  const cookies: unknown[] = []
  const contexts = new BrowserDataContexts({
    session: () =>
      ({
        cookies: {
          get: async () => [],
          set: async (value: unknown) => {
            cookies.push(value)
          },
          flushStore: async () => {},
        },
      }) as never,
  })
  const record = {
    contextId: "fixture-context",
    epoch: "fixture-epoch",
    expiresAt: Date.now() + 15 * 60_000,
    ownerKey: "scope:home:scope",
    profile: { id: "personal", revision: 0, partition: "persist:synergy-browser-fixture" },
  }
  contexts.prepare(record)
  const store = new BrowserDataStore(root, {
    available: async () => true,
    encrypt: async (value) => Buffer.from(value).reverse(),
    decrypt: async (value) => Buffer.from(value).reverse().toString(),
  })
  const files = { passwords: path.join(root, "passwords.csv"), cookies: path.join(root, "cookies.json") }
  await writeFile(files.passwords, "url,username,password\nhttps://example.test,fixture-user,fixture-password\n")
  await writeFile(
    files.cookies,
    JSON.stringify([{ name: "session", value: "fixture-cookie", domain: "example.test", path: "/" }]),
  )
  let pageTargets = 0
  const actions = new BrowserDataActions({
    store,
    target: () => {
      pageTargets++
      throw new Error("No pages exist")
    },
    profileTarget: (id) => contexts.target(id),
    closeProfileContext: (id) => contexts.close(id),
    chooseFile: async (kind) => files[kind],
  })
  const request = { protocolVersion: BROWSER_PROTOCOL_VERSION, contextId: record.contextId }
  return { root, cookies, contexts, record, store, actions, request, pageTargets: () => pageTargets }
}

test("profile management imports passwords and cookies with zero page targets and metadata-only results", async () => {
  const f = await fixture()
  expect(BROWSER_PROTOCOL_VERSION).toBe(7)
  const imported = await f.actions.executeProfile({
    ...f.request,
    action: {
      type: "import",
      sourceId: "file",
      kinds: ["passwords", "cookies"],
      overwrite: false,
      requestId: "fixture-job",
    },
  })
  expect(imported).toMatchObject({ imported: 2, cancelled: false })
  const state = await f.actions.executeProfile({ ...f.request, action: { type: "state" } })
  expect(state).toMatchObject({ passwords: [{ origin: "https://example.test", username: "fixture-user" }] })
  expect(JSON.stringify([imported, state])).not.toMatch(/fixture-password|fixture-cookie|partition|encrypted/)
  expect(f.pageTargets()).toBe(0)
  expect(f.cookies).toHaveLength(1)
  const entry = (await f.store.list(f.record.profile.partition)).passwords[0]!
  await f.actions.executeProfile({ ...f.request, action: { type: "deletePassword", id: entry.id } })
  expect((await f.store.list(f.record.profile.partition)).passwords).toEqual([])
  await f.actions.executeProfile({ ...f.request, action: { type: "closeContext" } })
  await expect(f.actions.executeProfile({ ...f.request, action: { type: "state" } })).rejects.toThrow()
  await f.actions.executeProfile({ ...f.request, action: { type: "closeContext" } })
})

test("profile IPC rejects page actions, forged partitions, unknown contexts and stale epochs", async () => {
  const f = await fixture()
  for (const action of [{ type: "saveLogin" }, { type: "fillLogin", id: "login" }, { type: "clearHistory" }])
    expect(BrowserProfileDataRequestSchema.safeParse({ ...f.request, action }).success).toBe(false)
  expect(
    BrowserProfileDataRequestSchema.safeParse({ ...f.request, partition: "persist:another", action: { type: "state" } })
      .success,
  ).toBe(false)
  await expect(
    f.actions.executeProfile({ ...f.request, contextId: "forged", action: { type: "state" } }),
  ).rejects.toThrow()
  f.contexts.disconnect()
  await expect(f.actions.executeProfile({ ...f.request, action: { type: "state" } })).rejects.toThrow()
  f.contexts.prepare({ ...f.record, contextId: "fresh", epoch: "new-epoch" })
  await expect(f.actions.executeProfile({ ...f.request, action: { type: "state" } })).rejects.toThrow()
})

test("short-lived data contexts abort on expiry and refuse late writes", async () => {
  const f = await fixture()
  f.contexts.prepare({ ...f.record, contextId: "expiring", expiresAt: Date.now() + 15 })
  const target = f.contexts.target("expiring")
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(target.signal.aborted).toBe(true)
  await expect(target.write(async () => "late")).rejects.toThrow()
  expect(() => f.contexts.target("expiring")).toThrow()
})

test("revocation while encryption waits prevents a late password from resurrecting cleared data", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>()
  const store = new BrowserDataStore(f.root, {
    available: async () => true,
    encrypt: async (value) => {
      entered.resolve()
      await held.promise
      return Buffer.from(value).reverse()
    },
    decrypt: async (value) => Buffer.from(value).reverse().toString(),
  })
  const file = path.join(f.root, "passwords.csv")
  const actions = new BrowserDataActions({
    store,
    target: () => {
      throw new Error("No pages")
    },
    profileTarget: (id) => f.contexts.target(id),
    chooseFile: async () => file,
  })
  const pending = actions.executeProfile({
    ...f.request,
    action: { type: "import", sourceId: "file", kinds: ["passwords"], overwrite: false, requestId: "held" },
  })
  await entered.promise
  f.contexts.revokeProfile("personal")
  await store.clear(f.record.profile.partition)
  held.resolve()
  expect(await pending).toMatchObject({ imported: 0, cancelled: true })
  expect((await store.list(f.record.profile.partition)).passwords).toEqual([])
  await expect(
    actions.executeProfile({ ...f.request, action: { type: "importProgress", requestId: "held" } }),
  ).rejects.toThrow()
  await actions.executeProfile({ ...f.request, action: { type: "cancelImport", requestId: "held" } })
})
