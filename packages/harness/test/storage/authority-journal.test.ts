import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { createHash } from "node:crypto"
import { AuthorityJournal } from "../../src/storage/authority-journal"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"
import type { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"

const Policy = z.strictObject({
  enabled: z.boolean(),
  revision: z.number().int(),
  credential: z.string(),
  lastSeen: z.number().optional(),
})
const actor: ActorStamp.Info = {
  kind: "account",
  orgID: "org",
  subjectID: "owner",
  displayName: "Owner",
  clientKind: "web",
  requestID: "policy-change",
}

test("archived authority checkpoints retain their historical head and require complete authenticated EOF", async () => {
  await using f = await fixture()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "journal-checkpoint-"))
  const keys = {
    async current() {
      return { version: "fixture", key: Buffer.alloc(32, 7) }
    },
    async resolve() {
      return Buffer.alloc(32, 7)
    },
  }
  try {
    await f.run(async () => {
      const head = await AuthorityJournal.head()
      const archive = path.join(directory, "archive")
      const expected = await StorageCheckpoint.exportArchive({
        directory: archive,
        archiveID: "historical-head",
        namespaceID: "opaque-checkpoint-namespace",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      await AuthorityJournal.transaction("policy.after-checkpoint", async (journal) => {
        journal.identify(actor)
        await Storage.write(["policy", "one"], { enabled: false, revision: 2, credential: "later-credential" })
      })
      expect(await AuthorityJournal.readArchivedCheckpoint({ directory: archive, expected, keys })).toEqual(head)
      expect((await AuthorityJournal.head()).sequence).toBeGreaterThan(head.sequence)
      const records = path.join(archive, "records.ndjson")
      const original = await fs.readFile(records)
      await fs.writeFile(records, original.subarray(0, original.byteLength - 5))
      await expect(AuthorityJournal.readArchivedCheckpoint({ directory: archive, expected, keys })).rejects.toThrow()
      await fs.writeFile(records, original)
      const controller = new AbortController()
      controller.abort(new Error("Cancelled historical checkpoint"))
      await expect(
        AuthorityJournal.readArchivedCheckpoint({ directory: archive, expected, keys, signal: controller.signal }),
      ).rejects.toThrow("Cancelled historical checkpoint")
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
async function fixture() {
  const runtime = await storageTestRuntime()
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "authority-journal-"))
  const store = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
  )
  const run = <T>(body: () => Promise<T>) =>
    runtime.run(() => Storage.provide({ store, artifactDirectory: path.join(root, "content") }, body))
  await runtime.run(() =>
    AuthorityJournal.register({
      id: "policy",
      version: 1,
      prefixes: [["policy"]],
      project(_key, value) {
        const policy = Policy.parse(value)
        return {
          enabled: policy.enabled,
          revision: policy.revision,
          credentialHash: createHash("sha256").update(policy.credential).digest("hex"),
        }
      },
    }),
  )
  await run(async () => {
    await Storage.write(["policy", "one"], { enabled: true, revision: 1, credential: "fixture-private-credential" })
    await AuthorityJournal.initialize({ namespaceID: "organization" })
  })
  return {
    run,
    store,
    async [Symbol.asyncDispose]() {
      await store.close()
      await runtime.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("authority history commits real policy changes with redacted attribution and rolls back with its writer", async () => {
  await using f = await fixture()
  await f.run(async () => {
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
    const definition = AuthorityJournal.definition()
    definition.domains[0]?.prefixes[0]?.splice(0, 1, "foreign-policy")
    expect(AuthorityJournal.definition().hash).toBe(definition.hash)
    const before = await AuthorityJournal.head()
    await AuthorityJournal.transaction("policy.disable", async (journal) => {
      journal.identify(actor)
      await Storage.write(["policy", "one"], { enabled: false, revision: 2, credential: "fixture-private-credential" })
      await Storage.write(["policy", "two"], { enabled: true, revision: 1, credential: "second-private-credential" })
    })
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
    const page = await AuthorityJournal.entries({ limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.actor).toEqual(actor)
    expect(page.items[0]?.previousHash).toBe(before.tailHash)
    expect(JSON.stringify(page)).not.toContain("fixture-private-credential")
    const second = await AuthorityJournal.entries({ after: page.items[0]!.sequence, limit: 1 })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.previousHash).toBe(page.items[0]?.hash)
    const stable = await AuthorityJournal.head()
    await expect(
      AuthorityJournal.transaction("policy.rollback", async (journal) => {
        journal.identify(actor)
        await Storage.removeTree(["policy"])
        throw new Error("Synthetic policy rollback")
      }),
    ).rejects.toThrow("policy rollback")
    expect(await AuthorityJournal.head()).toEqual(stable)
    expect(await Storage.read(["policy", "one"])).toMatchObject({ enabled: false })
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
  })
})

test("an unhooked authority write cannot be healed by a later journaled action", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await Storage.write(["policy", "one"], { enabled: false, revision: 2, credential: "fixture-private-credential" })
    expect((await AuthorityJournal.inspect()).covered).toBe(false)
    await AuthorityJournal.transaction("policy.known-after-gap", async (journal) => {
      journal.identify(actor)
      await Storage.write(["policy", "one"], { enabled: true, revision: 3, credential: "fixture-private-credential" })
    })
    expect((await AuthorityJournal.inspect()).covered).toBe(false)
    await expect(
      AuthorityJournal.transaction("policy.missing-actor", async () => {
        await Storage.write(["policy", "one"], {
          enabled: false,
          revision: 4,
          credential: "fixture-private-credential",
        })
      }),
    ).rejects.toThrow("actor")
    expect(await Storage.read(["policy", "one"])).toMatchObject({ revision: 3 })
  })
})

test("metadata heartbeats preserve coverage while an untracked policy transition cannot disappear by returning to its old value", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const original = { enabled: true, revision: 1, credential: "fixture-private-credential" }
    await Storage.write(["policy", "one"], { ...original, lastSeen: 123 })
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
    await Storage.write(["policy", "one"], { ...original, enabled: false })
    await Storage.write(["policy", "one"], original)
    expect((await AuthorityJournal.inspect()).covered).toBe(false)
  })
})

test("authority changes cross metadata page windows and remain atomic with a late native commit guard", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await AuthorityJournal.transaction("policy.bulk", async (journal) => {
      journal.identify(actor)
      for (let index = 0; index < 257; index++)
        await Storage.write(["policy", String(index).padStart(4, "0")], {
          enabled: true,
          revision: 1,
          credential: `fixture-${index}`,
        })
    })
    const head = await AuthorityJournal.head()
    expect(head.sequence).toBe(257)
    let after: number | undefined
    let count = 0
    let previous = head.baselineHash
    for (;;) {
      const page = await AuthorityJournal.entries({ after, limit: 31 })
      expect(page.items.length).toBeLessThanOrEqual(31)
      for (const item of page.items) {
        expect(item.previousHash).toBe(previous)
        previous = item.hash
        count++
      }
      if (!page.cursor) break
      after = page.cursor
    }
    expect(count).toBe(257)
    expect(previous).toBe(head.tailHash)
    await expect(
      AuthorityJournal.transaction(
        "policy.guard",
        async (journal) => {
          journal.identify(actor)
          await Storage.removeTree(["policy"])
        },
        {
          commitGuard() {
            throw new Error("Synthetic late authority loss")
          },
        },
      ),
    ).rejects.toThrow("late authority loss")
    expect(await AuthorityJournal.head()).toEqual(head)
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
  })
})

test("changed history or baseline proof blocks coverage without changing current policy authorization", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await AuthorityJournal.transaction("policy.change", async (journal) => {
      journal.identify(actor)
      await Storage.write(["policy", "one"], { enabled: false, revision: 2, credential: "fixture-private-credential" })
    })
    const page = await AuthorityJournal.entries({ limit: 1 })
    const entry = page.items[0]!
    await Storage.write(
      ["storage_authority_journal", "entries", page.head.journalID, String(entry.sequence).padStart(16, "0")],
      { ...entry, actor: { ...actor, subjectID: "forged" } },
    )
    expect((await AuthorityJournal.inspect()).chainValid).toBe(false)
    expect((await AuthorityJournal.inspect()).covered).toBe(false)
    expect(await Storage.read(["policy", "one"])).toMatchObject({ enabled: false })
    await Storage.write(
      ["storage_authority_journal", "entries", page.head.journalID, String(entry.sequence).padStart(16, "0")],
      entry,
    )
    expect((await AuthorityJournal.inspect()).chainValid).toBe(true)
    const baseline = (
      await Storage.query({ prefix: ["storage_authority_journal", "baseline", page.head.journalID], limit: 1 })
    )[0]!
    const original = z
      .strictObject({
        sequence: z.number(),
        fingerprint: z.strictObject({ domainID: z.string(), key: z.array(z.string()), hash: z.string() }),
      })
      .parse(baseline.value)
    await Storage.write(baseline.key, { ...original, fingerprint: { ...original.fingerprint, hash: "0".repeat(64) } })
    expect((await AuthorityJournal.inspect()).chainValid).toBe(false)
  })
})

test("an unselected journal preserves ordinary transactions while never claiming recovery coverage", async () => {
  const runtime = await storageTestRuntime()
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "unselected-authority-journal-"))
  const store = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
  )
  try {
    await runtime.run(() =>
      Storage.provide({ store, artifactDirectory: path.join(root, "content") }, async () => {
        await AuthorityJournal.transaction("policy.unselected", async (journal) => {
          journal.identify(actor)
          await Storage.write(["policy", "one"], { enabled: false })
        })
        expect(await Storage.read(["policy", "one"])).toEqual({ enabled: false })
        expect((await AuthorityJournal.inspect()).covered).toBe(false)
      }),
    )
  } finally {
    await store.close()
    await runtime.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
