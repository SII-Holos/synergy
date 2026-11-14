import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutToolPartIndex } from "../../src/session/rollout/tool-part-index"
import { prepareSessionMigrations } from "../../src/migration"
import type { RolloutSchema } from "../../src/session/rollout/schema"
import { StoreTransaction } from "../../src/storage/transactional-store"

test("tool lookup uses a maintained exact index and rolls back with its native journal record", async () => {
  let fail = false
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("tool-index-failure", async (_tx, keys) => {
        if (fail && keys.some((key) => key[4] === "tool_parts")) throw new Error("injected index failure")
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const owner = { kind: "session" as const, scopeID: "home", sessionID: session.id }
        await prepareSessionMigrations(owner)
        const input = await RolloutArtifact.writeText(owner, "{}", "application/json")
        const root = [...RolloutArtifact.root(owner), "runs", "msg_root", "tools"]
        let target: RolloutSchema.ToolExecutionRecord | undefined
        for (let index = 0; index < 129; index++) {
          const value: RolloutSchema.ToolExecutionRecord = {
            version: 1,
            id: crypto.randomUUID(),
            owner,
            runID: "msg_root",
            messageID: "msg_tools",
            toolCallID: "call_" + index,
            tool: "fixture",
            started: index,
            status: "running",
            input,
          }
          await RolloutJournal.write(owner, [...root, value.id], value)
          if (index === 128) target = value
        }
        const query = { runID: "msg_root", messageID: "msg_tools", toolCallID: "call_128", tool: "fixture" }
        {
          using noScan = spyOn(Storage, "records").mockImplementation(() => {
            throw new Error("Foreground tool inventory scan is forbidden")
          })
          expect(await RolloutLedger.toolForPart(owner, query)).toEqual(target!)
          expect(await RolloutLedger.toolForPart(owner, { ...query, toolCallID: "not-recorded" })).toBeUndefined()
          const versioned = StoreTransaction.prototype.versioned
          using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
            this: StoreTransaction,
            key: string[],
          ) {
            if (key.at(-2) === "tools") throw new Error("Native input locators cannot read complete execution records")
            return (versioned<T>).call(this, key)
          })
          const metadata = await RolloutToolPartIndex.input(owner, RolloutToolPartIndex.locator(query))
          expect(metadata?.reference.id).toBe(input.id)
          expect(metadata?.reference.sha256).toEqual(input.sha256)
          expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(1024)
        }
        const next = { ...target!, id: crypto.randomUUID(), started: 1000 }
        const before = await RolloutJournal.head(owner)
        fail = true
        try {
          await expect(RolloutJournal.write(owner, [...root, next.id], next)).rejects.toThrow(
            "Unable to persist rollout evidence",
          )
        } finally {
          fail = false
        }
        await expect(Storage.read([...root, next.id])).rejects.toThrow()
        expect(await RolloutJournal.head(owner)).toEqual(before)
        expect(await RolloutLedger.toolForPart(owner, query)).toEqual(target!)
        await RolloutJournal.write(owner, [...root, next.id], next)
        expect(await RolloutLedger.toolForPart(owner, query)).toEqual(next)
        const conflicting = {
          ...next,
          id: crypto.randomUUID(),
          input: await RolloutArtifact.writeText(owner, '{"different":true}', "application/json"),
        }
        await RolloutJournal.write(owner, [...root, conflicting.id], conflicting)
        await expect(RolloutLedger.toolForPart(owner, query)).rejects.toThrow("ambiguous")
        const newer = { ...next, id: crypto.randomUUID(), started: 1001 }
        await RolloutJournal.write(owner, [...root, newer.id], newer)
        expect(
          await RolloutLedger.toolForPart({ sessionID: session.id, scopeID: "home", kind: "session" }, query),
        ).toEqual(newer)
      },
    }),
  )
}, 15000)

test("the owning upgrade rebuilds legacy index entries from canonical records and ordinary input reads never backfill them", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const owner = { kind: "session" as const, scopeID: "home", sessionID: session.id }
        const input = await RolloutArtifact.writeText(owner, '{"original":true}', "application/json")
        const historical: RolloutSchema.ToolExecutionRecord = {
          version: 1,
          id: crypto.randomUUID(),
          owner,
          runID: "legacy-run",
          messageID: "legacy-message",
          toolCallID: "legacy-call",
          tool: "fixture",
          status: "failed",
          error: "huge retained error".repeat(50_000),
          started: 1,
          input,
        }
        await Storage.write(
          [...RolloutArtifact.root(owner), "runs", historical.runID, "tools", historical.id],
          historical,
        )
        const locator = RolloutToolPartIndex.locator(historical)
        const key = [...RolloutArtifact.root(owner), "tool_parts", locator.runID, locator.digest]
        const legacy = {
          version: 1,
          toolID: historical.id,
          started: historical.started,
          inputHash: input.sha256,
          ambiguous: false,
        }
        await Storage.write(key, legacy)
        await Storage.remove([...RolloutArtifact.root(owner), "tool_part_schema"])
        await Storage.write(
          ["sessions", "home", session.id, "migrations", "session", RolloutToolPartIndex.sessionMigration.id],
          { completed: Date.now() },
        )
        await expect(RolloutToolPartIndex.input(owner, locator)).rejects.toThrow()
        expect(await Storage.read(key)).toEqual(legacy)
        await prepareSessionMigrations(owner)
        const versioned = StoreTransaction.prototype.versioned
        using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          current: string[],
        ) {
          if (current.at(-2) === "tools")
            throw new Error("An upgraded input locator cannot reopen the complete execution record")
          return (versioned<T>).call(this, current)
        })
        const metadata = await RolloutToolPartIndex.input(owner, locator)
        expect(metadata?.reference.id).toBe(input.id)
        expect(metadata?.reference.sha256).toEqual(input.sha256)
        expect(await Storage.read(key)).toMatchObject({ version: 2, toolID: historical.id })
      },
    }),
  )
}, 15000)

test("central owner migration upgrades historical tool records once without scanning unrelated Sessions", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const owner = { kind: "session" as const, scopeID: "home", sessionID: session.id }
        const input = await RolloutArtifact.writeText(owner, "{}", "application/json")
        const historical: RolloutSchema.ToolExecutionRecord = {
          version: 1,
          id: crypto.randomUUID(),
          owner,
          runID: "msg_old",
          messageID: "msg_old_assistant",
          toolCallID: "old-call",
          tool: "fixture",
          started: 1,
          status: "completed",
          input,
        }
        await Storage.write(
          [...RolloutArtifact.root(owner), "runs", historical.runID, "tools", historical.id],
          historical,
        )
        expect(await RolloutToolPartIndex.get(owner, historical)).toBeUndefined()
        await prepareSessionMigrations(owner)
        expect(await RolloutToolPartIndex.get(owner, historical)).toEqual(historical)
        using noScan = spyOn(Storage, "records").mockImplementation(() => {
          throw new Error("Completed index migration must not rewalk history")
        })
        await prepareSessionMigrations(owner)
        expect(await RolloutToolPartIndex.get(owner, historical)).toEqual(historical)
      },
    }),
  )
}, 15000)
