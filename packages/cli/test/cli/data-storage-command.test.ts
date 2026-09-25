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
import { executeSnapshots } from "../../src/cli/cmd/data/snapshots"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { afterAll as afterRuntimeTests } from "bun:test"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
let runtime: RuntimeContext.Instance
let fixture: Awaited<ReturnType<typeof runtimeHome>>

test("legacy snapshot packing works before SQL initialization without importing records", () =>
  runtime.run(async () => {
    const repo = path.join(Global.Path.data, "snapshot", "scope", "session")
    await SnapshotStore.initializeBareRepository(repo)
    const file = path.join(home, "retained.txt")
    await Bun.write(file, "retained")
    const oid = await SnapshotStore.command(repo, ["hash-object", "-w", file])
    const legacy = path.join(Global.Path.data, "notes", "home", "retained.json")
    await Bun.write(legacy, JSON.stringify({ text: "unmigrated" }))
    expect((await executeSnapshots({ action: "pack-legacy", scope: "scope", session: "session" })).ok).toBe(true)
    expect(await StorageBootstrap.status(Global.Path.root)).toBeUndefined()
    {
      const lock = await ServerProcessLock.acquire()
      try {
        expect(await executeSnapshots({ action: "pack-legacy", scope: "scope", apply: true })).toMatchObject({
          error: { code: "busy" },
        })
      } finally {
        await lock.release()
      }
    }
    expect(
      (await executeSnapshots({ action: "pack-legacy", scope: "scope", session: "session", apply: true })).ok,
    ).toBe(true)
    expect(await SnapshotStore.command(repo, ["cat-file", "-p", oid])).toBe("retained")
    expect(await StorageBootstrap.status(Global.Path.root)).toBeUndefined()
    expect(await Bun.file(legacy).json()).toEqual({ text: "unmigrated" })
    expect(await ServerProcessLock.read()).toBeUndefined()
  }))

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
  fixture = await runtimeHome()
  home = fixture.host.home
  runtime = RuntimeContext.create(fixture.host)
  runtime.run(() => {
    registerLocalRuntime()
    expect(Storage.available()).toBe(false)
  })
  output = []
  console.log = (...args) => output.push(args.map(String).join(" "))
})

afterEach(async () => {
  console.log = originalLog
  process.exitCode = originalExitCode ?? 0
  try {
    await runtime.run(async () => {
      ObservabilityMetrics.stop()
      await ObservabilityStore.stop()
      await Log.close()
    })
  } finally {
    runtime.dispose()
    await fixture[Symbol.asyncDispose]()
  }
})

test("status is read-only before initialization and resume creates a verifiable store", () =>
  runtime.run(async () => {
    const before = await fs.readdir(home)
    await invoke(["storage", "status"])
    expect(report()).toEqual({ phase: "uninitialized" })
    expect(await fs.readdir(home)).toEqual(before)
    await expect(invoke(["storage", "verify"])).rejects.toThrow("has not been initialized")
    await invoke(["storage", "resume"])
    expect(report()).toEqual({ backend: "sqlite", phase: "active", status: "ready" })
    expect(Storage.available()).toBe(false)
    expect(await ServerProcessLock.read()).toBeUndefined()
    await invoke(["storage", "verify"])
    expect(report()).toMatchObject({ backend: "sqlite", issues: [] })
    await invoke(["storage", "status"])
    expect(report()).toMatchObject({ backend: "sqlite", phase: "active", recoveryRecords: 0, pendingEvents: 0 })
  }))

test("prune requires exclusive storage ownership and releases it on completion", () =>
  runtime.run(async () => {
    await invoke(["storage", "resume"])
    const lock = await ServerProcessLock.acquire()
    try {
      await expect(invoke(["storage", "prune"])).rejects.toThrow()
    } finally {
      await lock.release()
    }
    await invoke(["storage", "prune"])
    expect(report()).toMatchObject({ deletedRecords: 0, pruned: [], deferred: [] })
    expect(Storage.available()).toBe(false)
    expect(await ServerProcessLock.read()).toBeUndefined()
  }))

test("resume preserves an interrupted JSON import and migrate activates a verified target", () =>
  runtime.run(async () => {
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
  }))

test("verify reports invalid relationships without repairing or discarding evidence", () =>
  runtime.run(async () => {
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
  }))

test("maintenance rejects an installed Runtime and malformed targets without changing authority", () =>
  runtime.run(async () => {
    await invoke(["storage", "resume"])
    const manifest = await StorageBootstrap.status(Global.Path.root)
    {
      await using handle = await StorageMaintenance.open()
      await expect(invoke(["storage", "resume"])).rejects.toThrow("cannot replace an attached Runtime storage Handle")
    }
    const target = path.join(home, "invalid.jsonc")
    await Bun.write(target, "{ invalid")
    await expect(invoke(["storage", "migrate", "--target", target])).rejects.toThrow("not valid JSONC")
    expect(await StorageBootstrap.status(Global.Path.root)).toEqual(manifest)
    expect(Storage.available()).toBe(false)
    expect(await ServerProcessLock.read()).toBeUndefined()
  }))

test("restore-backup publishes a verified separate home and refuses an existing destination", () =>
  runtime.run(async () => {
    const legacy = path.join(Global.Path.data, "notes", "home", "restored.json")
    await Bun.write(legacy, JSON.stringify({ text: "original" }))
    const prepared = await StorageBootstrap.prepare({ root: Global.Path.root })
    const state = await prepared.store.read<{ backup: string }>(["storage_import", "info"])
    await prepared.activate()
    await prepared.store.close()
    const target = path.join(home, "restored-home")
    await invoke(["storage", "restore-backup", state.backup, target])
    expect(report()).toMatchObject({ status: "restored", files: 1 })
    expect(await Bun.file(path.join(target, "data", "notes", "home", "restored.json")).json()).toEqual({
      text: "original",
    })
    await expect(invoke(["storage", "restore-backup", state.backup, target])).rejects.toThrow("exists")
    expect(Storage.available()).toBe(false)
  }))

test("restore-backup never publishes a destination when the final inventory digest is corrupt", () =>
  runtime.run(async () => {
    await Bun.write(path.join(Global.Path.data, "notes", "saved.json"), JSON.stringify({ saved: true }))
    const prepared = await StorageBootstrap.prepare({ root: Global.Path.root })
    const state = await prepared.store.read<{ backup: string }>(["storage_import", "info"])
    await prepared.activate()
    await prepared.store.close()
    const filename = path.join(state.backup, "manifest.json")
    const manifest = await Bun.file(filename).json()
    await Bun.write(filename, JSON.stringify({ ...manifest, inventorySHA256: "0".repeat(64) }))
    const target = path.join(home, "invalid-home")
    await expect(invoke(["storage", "restore-backup", state.backup, target])).rejects.toThrow("integrity")
    expect(await fs.readdir(home)).not.toContain("invalid-home")
    expect((await fs.readdir(home)).some((name) => name.startsWith(".synergy-restore-"))).toBe(false)
    expect(Storage.available()).toBe(false)
  }))
