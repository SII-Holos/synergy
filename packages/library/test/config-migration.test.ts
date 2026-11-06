import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { migrations } from "../src/migration"
import { disposeLibrary, registerLibrary } from "../src/register"

const ownerID = "20261012-library-config-owner"
const sharedIDs = [
  "20260617-config-identity-to-library",
  "20260618-config-repair-legacy-library-shapes",
  "20260625-config-engram-to-library",
]

function open(home: string, installed: boolean) {
  return testRuntime({
    home,
    env: { SYNERGY_CWD: home },
    composition: {
      register() {
        if (installed) registerLibrary()
        ConfigExtensions.completeRegistration()
      },
      services: () => ({ disposeExtensions: installed ? disposeLibrary : undefined }),
    },
  })
}

for (const completed of [false, true]) {
  test(`Library config waits for its owner with shared receipts ${completed ? "complete" : "pending"}`, async () => {
    await using home = await runtimeHome()
    const file = path.join(home.host.root, "config", "synergy.d", "30-library.jsonc")
    const original = {
      library: {
        memory: {
          retrieval: {
            categories: { user: { topK: 2, retained: { nested: true } }, futureCategory: { topK: 9 } },
            futureRetrieval: ["retained"],
          },
          futureMemory: { enabled: true },
        },
        experience: { learning: true, futureExperience: "retained" },
        futureLibrary: { values: [1, 2] },
      },
    }
    {
      await using seed = await open(home.host.home, false)
      await seed.run(async () => {
        const key = ["meta", "migration", "log-config"]
        const ledger = await Storage.read<Record<string, number>>(key)
        for (const id of sharedIDs) {
          if (completed) ledger[id] = 42
          else delete ledger[id]
        }
        await Storage.write(key, ledger)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, JSON.stringify(original))
      })
    }
    const before = await Bun.file(file).text()
    {
      await using absent = await open(home.host.home, false)
      await absent.run(async () => {
        expect(await Bun.file(file).text()).toBe(before)
        expect(await Config.globalRaw()).not.toHaveProperty("library")
        await Config.domainUpdate("general", { username: "unrelated" })
        expect(await Bun.file(file).text()).toBe(before)
      })
    }
    {
      await using installed = await open(home.host.home, true)
      await installed.run(async () => {
        const value = (await Config.domainGet("library")).library!
        expect(value.memory?.retrieval?.categories?.user).toEqual({ topK: 2 })
        expect(value.experience?.learning).toBeUndefined()
        expect(value.memory).not.toHaveProperty("futureMemory")
        expect(value).not.toHaveProperty("futureLibrary")
        for (const mode of ["merge", "replace-domain"] as const) {
          await Config.domainUpdate("library", { library: { memory: { enabled: false } } }, { mode })
          const stored = (await Bun.file(file).json()).library
          expect(stored.memory.retrieval.categories.futureCategory).toEqual({ topK: 9 })
          expect(stored.memory.retrieval.categories.user.retained).toEqual({ nested: true })
          expect(stored.memory.retrieval.futureRetrieval).toEqual(["retained"])
          expect(stored.memory.futureMemory).toEqual({ enabled: true })
          expect(stored.experience.futureExperience).toBe("retained")
          expect(stored.futureLibrary).toEqual({ values: [1, 2] })
        }
        expect(
          (await Storage.read<Record<string, number>>(["meta", "migration", "log-library"]))[ownerID],
        ).toBeGreaterThan(0)
        expect(Config.diagnostics()).toEqual([])
      })
    }
    const preserved = await Bun.file(file).text()
    {
      await using absent = await open(home.host.home, false)
      await absent.run(async () => {
        expect(await Config.globalResolved()).not.toHaveProperty("library")
        await Config.domainUpdate("general", { username: "while unloaded" })
        expect(await Bun.file(file).text()).toBe(preserved)
      })
    }
    {
      await using restored = await open(home.host.home, true)
      await restored.run(async () => {
        expect((await Config.domainGet("library")).library?.memory?.enabled).toBe(false)
        expect(await Bun.file(file).text()).toBe(preserved)
      })
    }
  })
}

test("Library catches up legacy aliases without discarding unknown fields or replaying explicit settings", async () => {
  await using home = await runtimeHome()
  const dir = path.join(home.host.root, "config", "synergy.d")
  const source = path.join(dir, "30-engram.jsonc")
  const unknown = { future: ["preserved", 7] }
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    source,
    JSON.stringify({
      embedding: { model: "legacy-model" },
      engram: { memory: { retrieval: false }, futureLibrary: unknown },
      identity: {
        evolution: { active: { memoryDedupThreshold: 0.8, futurePolicy: unknown }, futureEvolution: unknown },
        futureIdentity: unknown,
      },
      futureRoot: unknown,
    }),
  )
  await Bun.write(path.join(dir, "00-general.jsonc"), JSON.stringify({ embedding: { model: "explicit-model" } }))
  {
    await using absent = await open(home.host.home, false)
    await absent.run(async () => {
      expect(await Config.globalRaw()).not.toHaveProperty("embedding")
      expect(await Bun.file(source).json()).toHaveProperty("engram")
    })
  }
  {
    await using installed = await open(home.host.home, true)
    await installed.run(async () => {
      expect((await Config.globalRaw()).embedding?.model).toBe("explicit-model")
      expect((await Config.domainGet("library")).library?.memory).toEqual({ enabled: false, dedup: { threshold: 0.8 } })
      const residual = await Bun.file(source).json()
      expect(residual).toEqual({
        identity: {
          evolution: { active: { futurePolicy: unknown }, futureEvolution: unknown },
          futureIdentity: unknown,
        },
        futureRoot: unknown,
      })
      expect((await Bun.file(ConfigDomain.filepath("library")).json()).library.futureLibrary).toEqual(unknown)
      const before = await Bun.file(source).text()
      await migrations.find((item) => item.id === ownerID)!.up(() => {})
      expect(await Bun.file(source).text()).toBe(before)
    })
  }
})

test("Library config migration keeps its source recoverable after a failed destination write", async () => {
  await using home = await runtimeHome()
  await using runtime = await open(home.host.home, true)
  await runtime.run(async () => {
    const dir = path.dirname(ConfigDomain.filepath("library"))
    const source = path.join(dir, "30-engram.jsonc")
    const target = ConfigDomain.filepath("library")
    await Bun.write(source, JSON.stringify({ engram: { memory: { enabled: false }, future: { retained: true } } }))
    await fs.mkdir(target, { recursive: true })
    const before = await Bun.file(source).text()
    const migration = migrations.find((item) => item.id === ownerID)!
    expect(migration).toBeDefined()
    await expect(migration.up(() => {})).rejects.toThrow()
    expect(await Bun.file(source).text()).toBe(before)
    await fs.rmdir(target)
    await migration.up(() => {})
    expect((await Bun.file(target).json()).library).toEqual({ memory: { enabled: false }, future: { retained: true } })
    const after = await Bun.file(target).text()
    await migration.up(() => {})
    expect(await Bun.file(target).text()).toBe(after)
  })
})

test("Library model settings preserve unknown fields through public general-domain replacement", async () => {
  await using home = await runtimeHome()
  const file = path.join(home.host.root, "config", "synergy.d", "00-general.jsonc")
  const retained = { nextVersion: ["unchanged"] }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({
      embedding: { model: "configured", future: retained, local: { source: "huggingface", future: retained } },
      rerank: { model: "configured", future: retained },
    }),
  )
  await using runtime = await open(home.host.home, true)
  await runtime.run(async () => {
    expect((await Config.domainGet("general")).embedding).toEqual({
      model: "configured",
      local: { source: "huggingface" },
    })
    expect((await Config.domainGet("general")).rerank).toEqual({ model: "configured" })
    await Config.domainUpdate("general", { username: "edited" }, { mode: "replace-domain" })
    const stored = await Bun.file(file).json()
    expect(stored.embedding.future).toEqual(retained)
    expect(stored.embedding.local.future).toEqual(retained)
    expect(stored.rerank.future).toEqual(retained)
    expect(Config.diagnostics()).toEqual([])
  })
})
