import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import yargs from "yargs"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { StorageMaintenance } from "@ericsanchezok/synergy-harness/storage/maintenance"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { DataStorageCommand } from "../../src/cli/cmd/data/storage"

const originalHome = process.env.SYNERGY_HOME
const originalLog = console.log
const originalExitCode = process.exitCode
let home: string
let output: string[] = []
const invoke = (args: string[]) =>
  yargs(args)
    .exitProcess(false)
    .showHelpOnFail(false)
    .fail((message, error) => {
      throw error ?? new Error(message)
    })
    .command(DataStorageCommand)
    .parseAsync()
const report = () => JSON.parse(output.at(-1)!)

beforeEach(async () => {
  expect(Storage.available()).toBe(false)
  home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-command-"))
  process.env.SYNERGY_HOME = home
  output = []
  console.log = (...args) => output.push(args.map(String).join(" "))
})

afterEach(async () => {
  console.log = originalLog
  process.exitCode = originalExitCode ?? 0
  if (originalHome === undefined) delete process.env.SYNERGY_HOME
  else process.env.SYNERGY_HOME = originalHome
  if (home) await fs.rm(home, { recursive: true, force: true })
})

test("status is read-only before initialization and resume creates a verifiable store", async () => {
  await invoke(["storage", "status"])
  expect(report()).toEqual({ phase: "uninitialized" })
  expect(await fs.readdir(home)).toEqual([])
  await expect(invoke(["storage", "verify"])).rejects.toThrow("has not been initialized")
  await invoke(["storage", "resume"])
  expect(report()).toEqual({ backend: "sqlite", phase: "active", status: "ready" })
  expect(Storage.available()).toBe(false)
  expect(await ServerProcessLock.read()).toBeUndefined()
  await invoke(["storage", "verify"])
  expect(report()).toMatchObject({ backend: "sqlite", issues: [] })
  await invoke(["storage", "status"])
  expect(report()).toMatchObject({ backend: "sqlite", phase: "active", recoveryRecords: 0, pendingEvents: 0 })
})

test("resume preserves an interrupted JSON import and migrate activates a verified target", async () => {
  const legacy = path.join(Global.Path.data, "notes", "home", "retained.json")
  await Bun.write(legacy, JSON.stringify({ text: "retained", extension: { version: 7 } }))
  const prepared = await StorageBootstrap.prepare({ root: Global.Path.root })
  await prepared.store.close()
  await invoke(["storage", "status"])
  expect(report()).toMatchObject({ phase: "validating", backend: "sqlite", backupID: prepared.manifest.backupID })
  await invoke(["storage", "resume"])
  expect(report().status).toBe("ready")
  expect(await Bun.file(legacy).exists()).toBe(false)
  {
    await using handle = await StorageMaintenance.open()
    await handle.store.write(["storage_recovery", "fixture"], { pending: true })
    await handle.store.transaction((tx) =>
      tx.enqueue({ id: "pending", scopeID: "scope", type: "changed", payload: { value: 7 } }),
    )
  }
  await invoke(["storage", "status"])
  expect(report()).toMatchObject({ recoveryRecords: 1, pendingEvents: 1 })
  const target = path.join(home, "target.jsonc")
  await Bun.write(
    target,
    '{ // target configuration\n "storage": { "backend": "sqlite", "filename": "data/storage/moved.sqlite" } }',
  )
  await invoke(["storage", "migrate", "--target", target])
  expect(output.at(-1)).toContain("migrated and verified")
  await using moved = await StorageMaintenance.open({ readonly: true })
  expect(moved.store.options).toMatchObject({ filename: path.join(Global.Path.data, "storage", "moved.sqlite") })
  expect(
    await moved.store.read<{ text: string; extension: { version: number } }>(["notes", "home", "retained"]),
  ).toEqual({ text: "retained", extension: { version: 7 } })
  expect(await moved.store.pendingEventCount()).toBe(1)
})

test("verify reports invalid relationships without repairing or discarding evidence", async () => {
  await invoke(["storage", "resume"])
  const key = ["sessions", "scope", "session", "messages", "message", "info"]
  {
    await using handle = await StorageMaintenance.open()
    await handle.store.write(key, { id: "message", retained: true })
  }
  await invoke(["storage", "verify"])
  expect(process.exitCode).toBe(1)
  expect(report().issues).toContainEqual({ key, reason: "missing_session" })
  await using handle = await StorageMaintenance.open({ readonly: true })
  expect(await handle.store.read<{ id: string; retained: boolean }>(key)).toEqual({ id: "message", retained: true })
})

test("maintenance rejects an installed Runtime and malformed targets without changing authority", async () => {
  await invoke(["storage", "resume"])
  const manifest = await StorageBootstrap.status(Global.Path.root)
  {
    await using handle = await StorageMaintenance.open()
    await expect(invoke(["storage", "resume"])).rejects.toThrow("cannot replace an installed Runtime Handle")
  }
  const target = path.join(home, "invalid.jsonc")
  await Bun.write(target, "{ invalid")
  await expect(invoke(["storage", "migrate", "--target", target])).rejects.toThrow("not valid JSONC")
  expect(await StorageBootstrap.status(Global.Path.root)).toEqual(manifest)
  expect(Storage.available()).toBe(false)
  expect(await ServerProcessLock.read()).toBeUndefined()
})
