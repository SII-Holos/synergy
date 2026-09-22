import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { StorageFormatV3Migration } from "../../src/storage/format-v3-migration"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { createV2Store, keyHex } from "./format-v3-fixture"
import { StorageReclamation } from "../../src/storage/format-reclamation"
import { StorageFormatV3State } from "../../src/storage/format-v3-state"
import { UpgradeWork } from "../../src/storage/upgrade-work"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "format-ready-"))
  const filename = path.join(root, "agent.sqlite")
  const records = Array.from({ length: 600 }, (_, index) => ({
    key: ["fixture", String(index)],
    body: JSON.stringify({ index, text: "retained evidence ".repeat(80) }),
  })).sort((a, b) => keyHex(a.key).localeCompare(keyHex(b.key)))
  createV2Store({ filename, namespace: "ready", incrementalVacuum: true, records })
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "ready", filename })
  return {
    store,
    records,
    filename,
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("format conversion returns with usable records before reclaiming any page", () =>
  runtime.run(async () => {
    await using value = await fixture()
    const phases: number[] = []
    await StorageFormatV3Migration.run({
      store: value.store,
      progress: (_current, _total, phase) => phases.push(phase),
    })
    expect(value.store.keyEncodedAs).toBe("bytes")
    expect(await value.store.read<Record<string, unknown>>(value.records[0]!.key)).toEqual(
      JSON.parse(value.records[0]!.body),
    )
    expect(phases).not.toContain(5)
    const [row] = await value.store.snapshot((tx) =>
      tx.raw.query<{ state: string }>("SELECT state FROM storage_format_v3_state WHERE namespace = ?", ["ready"]),
    )
    expect(JSON.parse(row!.state).phase).toBe("reclaim")
  }))

test("node derivation resumes after its durable batch instead of starting again", () =>
  runtime.run(async () => {
    await using value = await fixture()
    await expect(
      StorageFormatV3Migration.run({
        store: value.store,
        progress: (current, _total, phase) => {
          if (phase === 2 && current >= 256) throw new Error("interrupt nodes")
        },
      }),
    ).rejects.toThrow("interrupt nodes")
    const counts: number[] = []
    await StorageFormatV3Migration.run({
      store: value.store,
      progress: (current, _total, phase) => {
        if (phase === 2) counts.push(current)
      },
    })
    expect(counts.at(-1)).toBe(344)
    expect((await value.store.verify()).issues).toEqual([])
  }))

test("paused reclamation survives reopening and resumes independently of the format migration", () =>
  runtime.run(async () => {
    await using value = await fixture()
    await StorageFormatV3Migration.run({ store: value.store })
    await StorageReclamation.control(value.store, "pause")
    await value.store.close()
    const reopened = await TransactionalStore.open({ backend: "sqlite", filename: value.filename, namespace: "ready" })
    try {
      expect((await StorageReclamation.status(reopened)).reclaim).toMatchObject({ pending: true, paused: true })
      await StorageFormatV3Migration.run({ store: reopened })
      await StorageReclamation.pass(reopened)
      expect((await StorageReclamation.status(reopened)).reclaim).toMatchObject({ pending: true, releasedPages: 0 })
      await StorageReclamation.control(reopened, "resume")
      expect((await StorageReclamation.drain(reopened)).reclaim).toMatchObject({ pending: false, paused: false })
      expect(await reopened.read<Record<string, unknown>>(value.records[0]!.key)).toEqual(
        JSON.parse(value.records[0]!.body),
      )
    } finally {
      await reopened.close()
    }
  }))

test("background reclamation yields to foreground work and can be drained on shutdown", () =>
  runtime.run(async () => {
    await using value = await fixture()
    await StorageFormatV3Migration.run({ store: value.store })
    let busy = true
    const stop = StorageReclamation.start(value.store, { busy: () => busy, intervalMs: 5 })
    try {
      await value.store.write(["fixture", "foreground"], { kept: true })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect((await StorageReclamation.status(value.store)).reclaim).toMatchObject({ pending: true, releasedPages: 0 })
      busy = false
      const deadline = Date.now() + 5000
      while ((await StorageReclamation.status(value.store)).reclaim.pending && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect((await StorageReclamation.status(value.store)).reclaim.pending).toBe(false)
      expect(await value.store.read<Record<string, boolean>>(["fixture", "foreground"])).toEqual({ kept: true })
    } finally {
      await stop()
    }
  }))

test("resuming an interrupted copy preserves writes and deletion after the interruption", () =>
  runtime.run(async () => {
    await using value = await fixture()
    await expect(
      StorageFormatV3Migration.run({
        store: value.store,
        progress: (current, _total, phase) => {
          if (phase === 1 && current >= 256) throw new Error("interrupt copied batch")
        },
      }),
    ).rejects.toThrow("interrupt copied batch")
    await value.store.write(value.records[0]!.key, { changed: true })
    await value.store.remove(value.records[1]!.key)
    await value.store.write(["fixture", "new"], { created: true })
    await StorageFormatV3Migration.run({ store: value.store })
    expect(await value.store.read<Record<string, unknown>>(value.records[0]!.key)).toEqual({ changed: true })
    expect(await value.store.readMany([value.records[1]!.key])).toEqual([undefined])
    expect(await value.store.read<Record<string, boolean>>(["fixture", "new"])).toEqual({ created: true })
  }))

test("cancellation stops at a committed copy cursor and a new Handle resumes", () =>
  runtime.run(async () => {
    await using value = await fixture()
    const controller = new AbortController()
    await expect(
      UpgradeWork.run({ background: false, signal: controller.signal }, () =>
        StorageFormatV3Migration.run({
          store: value.store,
          progress: (current, _total, phase) => {
            if (phase === 1 && current >= 256) controller.abort(new Error("cancelled"))
          },
        }),
      ),
    ).rejects.toThrow("cancelled")
    expect((await StorageFormatV3State.read(value.store))?.recordsCursor).not.toBe("")
    await value.store.close()
    const reopened = await TransactionalStore.open({ backend: "sqlite", filename: value.filename, namespace: "ready" })
    try {
      await StorageFormatV3Migration.run({ store: reopened })
      expect((await reopened.verify()).issues).toEqual([])
      expect(await reopened.read<Record<string, unknown>>(value.records.at(-1)!.key)).toEqual(
        JSON.parse(value.records.at(-1)!.body),
      )
    } finally {
      await reopened.close()
    }
  }))

test("a failed swap transaction preserves both the old data and its checkpoint", () =>
  runtime.run(async () => {
    await using value = await fixture()
    await expect(
      StorageFormatV3Migration.run({
        store: value.store,
        progress: (_current, _total, phase) => {
          if (phase === 4) throw new Error("before swap")
        },
      }),
    ).rejects.toThrow("before swap")
    const before = await StorageFormatV3State.read(value.store)
    await expect(
      value.store.maintainDdlTransaction([
        { statement: "DROP TABLE storage_records" },
        { statement: "ALTER TABLE nonexistent_staging_table RENAME TO storage_records" },
      ]),
    ).rejects.toThrow()
    expect(await StorageFormatV3State.read(value.store)).toEqual(before)
    expect(await value.store.read<Record<string, unknown>>(value.records[0]!.key)).toEqual(
      JSON.parse(value.records[0]!.body),
    )
    await StorageFormatV3Migration.run({ store: value.store })
    expect(await StorageFormatV3Migration.isApplied(value.store)).toBe(true)
  }))

test("unfenced legacy staging is rebuilt while an already committed layout needs no rewrite", () =>
  runtime.run(async () => {
    await using value = await fixture()
    await expect(
      StorageFormatV3Migration.run({
        store: value.store,
        progress: (current, _total, phase) => {
          if (phase === 1 && current >= 256) throw new Error("old interruption")
        },
      }),
    ).rejects.toThrow()
    await value.store.maintainDdlTransaction(StorageFormatV3State.fences(false))
    await StorageFormatV3State.update(value.store, (state) => {
      const { fenced, ...legacy } = state
      return legacy
    })
    await value.store.write(value.records[0]!.key, { afterLegacyInterruption: true })
    await StorageFormatV3Migration.run({ store: value.store })
    expect(await value.store.read<Record<string, unknown>>(value.records[0]!.key)).toEqual({
      afterLegacyInterruption: true,
    })
    const phases: number[] = []
    await StorageFormatV3Migration.run({ store: value.store, progress: (_c, _t, phase) => phases.push(phase) })
    expect(phases).toEqual([])
    expect((await StorageReclamation.status(value.store)).reclaim.pending).toBe(true)
  }))

test("foreign namespaces and inconsistent committed checkpoints are rejected without copying", () =>
  runtime.run(async () => {
    await using value = await fixture()
    await value.store.transaction((tx) =>
      tx.raw.query(
        "INSERT INTO storage_namespaces(namespace,version,owner,state) VALUES ('foreign',2,'fixture','ready')",
      ),
    )
    await expect(StorageFormatV3Migration.run({ store: value.store })).rejects.toThrow("only its active namespace")
    expect(await StorageFormatV3State.read(value.store)).toBeUndefined()
    expect(await value.store.read<Record<string, unknown>>(value.records[0]!.key)).toEqual(
      JSON.parse(value.records[0]!.body),
    )
    await value.store.transaction((tx) => tx.raw.query("DELETE FROM storage_namespaces WHERE namespace = 'foreign'"))
    await StorageFormatV3Migration.run({ store: value.store })
    await StorageFormatV3State.update(value.store, (state) => ({ ...state, phase: "records" }))
    await expect(StorageFormatV3Migration.isApplied(value.store)).rejects.toThrow("disagree")
  }))

afterRuntimeTests(() => runtime.close())
