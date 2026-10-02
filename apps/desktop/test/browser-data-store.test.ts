import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BrowserDataStore, parsePasswordCSV, parseCookieImport } from "../src/browser-data-store"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const encryption = {
  available: async () => true,
  encrypt: async (text: string) => Buffer.from(text).reverse(),
  decrypt: async (data: Buffer) => Buffer.from(data).reverse().toString(),
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "synergy-browser-data-"))
  roots.push(root)
  return { root, store: new BrowserDataStore(root, encryption) }
}

test("password CSV accepts browser exports and quoted commas and newlines", () => {
  expect(
    parsePasswordCSV('\ufeffname,url,username,password\r\nSite,https://example.com/login,"a,b","line1\nline2"'),
  ).toEqual([{ origin: "https://example.com", username: "a,b", password: "line1\nline2" }])
  expect(() => parsePasswordCSV('url,username,password\n"unterminated')).toThrow()
  expect(() => parsePasswordCSV("url,username\nhttps://example.com,a")).toThrow()
})

test("passwords persist encrypted, isolate profiles and never appear in list results", async () => {
  const { root, store } = await fixture()
  await store.savePassword(
    "persist:one",
    { origin: "https://example.com", username: "fixture", password: "fixture-only-secret" },
    false,
  )
  const listed = await store.list("persist:one")
  expect(JSON.stringify(listed)).not.toContain("fixture-only-secret")
  expect((await store.list("persist:two")).passwords).toEqual([])
  expect(await store.password("persist:one", listed.passwords[0]!.id, "https://other.example")).toBeUndefined()
  const again = new BrowserDataStore(root, encryption)
  expect((await again.password("persist:one", listed.passwords[0]!.id, "https://example.com"))?.password).toBe(
    "fixture-only-secret",
  )
  expect(await readFile(store.file("persist:one"), "utf8")).not.toContain("fixture-only-secret")
  expect(
    await store.savePassword(
      "persist:one",
      { origin: "https://example.com", username: "fixture", password: "replacement" },
      false,
    ),
  ).toBe(false)
  await store.clearHistory("persist:one")
  expect((await store.list("persist:one")).passwords).toHaveLength(1)
  await store.removePassword("persist:one", listed.passwords[0]!.id)
  expect((await store.list("persist:one")).passwords).toHaveLength(0)
})

test("unavailable encryption and temporary profiles cannot persist passwords", async () => {
  const { root } = await fixture()
  const store = new BrowserDataStore(root, { ...encryption, available: async () => false })
  await expect(
    store.savePassword("persist:one", { origin: "https://example.com", username: "u", password: "p" }, false),
  ).rejects.toThrow()
  await expect(
    new BrowserDataStore(root, encryption).savePassword(
      "temporary",
      { origin: "https://example.com", username: "u", password: "p" },
      false,
    ),
  ).rejects.toThrow()
})

test("recent visits are bounded, deduplicated and never persist temporary pages", async () => {
  const { store } = await fixture()
  await Promise.all(
    Array.from({ length: 110 }, (_, i) => store.visit("persist:one", `https://example.com/${i}`, `Page ${i}`)),
  )
  await store.visit("persist:one", "https://example.com/5", "Changed title")
  const history = (await store.list("persist:one")).history
  expect(history).toHaveLength(100)
  expect(history[0]).toMatchObject({ url: "https://example.com/5", title: "Changed title" })
  await store.visit("temporary", "https://example.com", "Private")
  expect((await store.list("temporary")).history).toEqual([])
})

test("cookie import accepts documented storageState shape without merging origin storage", () => {
  expect(
    parseCookieImport(
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "fixture",
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    ),
  ).toHaveLength(1)
  expect(() => parseCookieImport('{"cookies":"bad"}')).toThrow()
})

test("profile deletion invalidates an encryption operation still in flight", async () => {
  const { root } = await fixture()
  let started!: () => void, resume!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    resume = resolve
  })
  const store = new BrowserDataStore(root, {
    ...encryption,
    encrypt: async (value) => {
      started()
      await waiting
      return encryption.encrypt(value)
    },
  })
  const pending = store.savePassword(
    "persist:deleted",
    { origin: "https://example.com", username: "fixture", password: "fixture" },
    false,
  )
  await entered
  await store.clear("persist:deleted")
  resume()
  await expect(pending).rejects.toThrow()
  expect((await store.list("persist:deleted")).passwords).toEqual([])
})
