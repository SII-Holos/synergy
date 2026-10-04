import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { StorageBootstrap } from "../../src/storage/bootstrap"
import { StorageCompat } from "../../src/storage/compat"
import { testRuntime } from "../support/runtime"
import released from "./fixtures/v3.0.22.json"

const runtime = await testRuntime()
const fixtures = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "legacy-startup-"))
afterAll(async () => {
  await runtime.close()
  await fs.rm(fixtures, { recursive: true, force: true })
})

const scopeLedger = { "20260424-scope-reclaim-orphans": 1 }
const configLedger = { "20260625-provider-auth-v2": 1 }
const navigation = { version: 1, scopeID: "home", updatedAt: 1, entries: [{ sessionID: "retained" }] }
const pluginLock = { version: 2, plugins: {} }

async function write(root: string, relative: string, value: unknown) {
  const filename = path.join(root, relative)
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const bytes = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  await fs.writeFile(filename, bytes)
  return bytes
}

async function home() {
  const root = path.join(fixtures, crypto.randomUUID(), ".synergy")
  for (const record of released.records) await write(root, `data/${record.key.join("/")}.json`, record.value)
  const prepared = await StorageBootstrap.prepare({ root })
  try {
    await prepared.store.write(["meta", "migration", "log-scope"], scopeLedger)
    await prepared.store.write(["meta", "migration", "log-config"], configLedger)
    await prepared.store.write(["session_nav_v2", "home"], navigation)
    await prepared.store.write(["plugin-lock"], pluginLock)
    await prepared.store.write(["plugin-approvals"], [])
    await prepared.store.write(["plugin-incompatible"], [])
    await prepared.activate()
  } finally {
    await prepared.store.close()
  }
  return root
}

function reclaimed(root: string) {
  const directory = path.join(root, "reclaimed")
  return {
    id: "__reclaimed__",
    type: "project",
    name: "Reclaimed",
    icon: { color: "gray" },
    directory,
    worktree: directory,
    sandboxes: [],
    time: { created: 2, updated: 2 },
  }
}

test("active startup preserves SQL authority and original bytes when an old startup recreates only metadata", () =>
  runtime.run(async () => {
    const root = await home()
    const residues = [
      ["data/meta/migration/log-scope.json", { "20260424-scope-reclaim-orphans": 2 }],
      ["data/meta/migration/log-config.json", { "20260625-provider-catalog-config": 2 }],
      ["data/session_nav_v2/home.json", { ...navigation, updatedAt: 2, entries: [] }],
      ["data/projects/__reclaimed__.json", reclaimed(root)],
      ["data/plugin-approvals.json", []],
      ["data/plugin-incompatible.json", []],
      ["plugin.lock", pluginLock],
    ] as const
    const originals = await Promise.all(residues.map(([relative, value]) => write(root, relative, value)))
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = await StorageBootstrap.prepare({ root })
      try {
        expect(reopened.manifest.phase).toBe("active")
        for (const record of released.records)
          expect(await reopened.store.read<unknown>(record.key)).toEqual(record.value)
        expect(await reopened.store.read<unknown>(["meta", "migration", "log-scope"])).toEqual(scopeLedger)
        expect(await reopened.store.read<unknown>(["meta", "migration", "log-config"])).toEqual(configLedger)
        expect(await reopened.store.read<unknown>(["session_nav_v2", "home"])).toEqual(navigation)
        expect(await reopened.store.readMany([["projects", "__reclaimed__"]])).toEqual([undefined])
        expect(await reopened.store.read<unknown>(["plugin-lock"])).toEqual(pluginLock)
        expect(await reopened.store.read<unknown>(["plugin-approvals"])).toEqual([])
        await StorageCompat.rejectForeignWriters(path.join(root, "data"), reopened.store)
      } finally {
        await reopened.store.close()
      }
      expect(await Promise.all(residues.map(([relative]) => Bun.file(path.join(root, relative)).text()))).toEqual(
        originals,
      )
    }
    await write(root, "data/session_nav_v2/home.json", { ...navigation, entries: [{ sessionID: "foreign" }] })
    await expect(StorageBootstrap.prepare({ root })).rejects.toThrow("Legacy JSON records appeared")
  }))

test.each([
  ["data/meta/migration/log-config.json", "{broken"],
  ["data/meta/migration/log-config.json", { migration: "not a completion timestamp" }],
  ["data/meta/migration/log-unknown.json", { migration: 2 }],
  ["data/session_nav_v2/home.json", { ...navigation, entries: [], unknown: true }],
  ["data/session_nav_v2/home.json", { ...navigation, scopeID: "other", entries: [] }],
  ["data/session_nav_v2/home.json", navigation],
  ["data/projects/unexpected.json", {}],
  ["data/plugin-approvals.json", [{ id: "foreign", capabilities: ["shell"] }]],
  ["data/plugin-incompatible.json", [{ id: "foreign" }]],
  ["plugin.lock", { version: 2, plugins: { foreign: {} } }],
  ["data/notes/foreign.json", { text: "retain this evidence" }],
  ["data/sessions/home/foreign/info.json", { title: "foreign session" }],
])(
  "startup still refuses conflicting or unrecognized legacy data at %s",
  runtime.bind(async (relative, value) => {
    const root = await home()
    const original = await write(root, relative, value)
    await expect(StorageBootstrap.prepare({ root })).rejects.toThrow("Legacy JSON records appeared")
    expect(await Bun.file(path.join(root, relative)).text()).toBe(original)
  }),
)

test("a changed reclaimed Scope and an empty legacy approval file cannot override canonical state", () =>
  runtime.run(async () => {
    const root = await home()
    await write(root, "data/projects/__reclaimed__.json", { ...reclaimed(root), sandboxes: ["retained"] })
    await expect(StorageBootstrap.prepare({ root })).rejects.toThrow("Legacy JSON records appeared")
    await fs.unlink(path.join(root, "data/projects/__reclaimed__.json"))
    const prepared = await StorageBootstrap.prepare({ root })
    try {
      await prepared.store.write(["plugin-approvals"], [{ id: "retained" }])
    } finally {
      await prepared.store.close()
    }
    await write(root, "data/plugin-approvals.json", [])
    await expect(StorageBootstrap.prepare({ root })).rejects.toThrow("Legacy JSON records appeared")
  }))

test("startup rejects oversized metadata without changing its bytes", () =>
  runtime.run(async () => {
    const root = await home()
    const relative = "data/meta/migration/log-config.json"
    const original = await write(root, relative, " ".repeat(1024 * 1024) + "{}")
    await expect(StorageBootstrap.prepare({ root })).rejects.toThrow("Legacy JSON records appeared")
    expect(await Bun.file(path.join(root, relative)).text()).toBe(original)
  }))

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "unreadable startup metadata remains a fatal I/O error",
  () =>
    runtime.run(async () => {
      const root = await home()
      const relative = "data/meta/migration/log-config.json"
      await write(root, relative, configLedger)
      const filename = path.join(root, relative)
      await fs.chmod(filename, 0)
      try {
        await expect(StorageBootstrap.prepare({ root })).rejects.toMatchObject({ code: "EACCES" })
      } finally {
        await fs.chmod(filename, 0o600)
      }
    }),
)
