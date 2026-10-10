import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { MessageV2 } from "../session/message-v2"
import { RolloutUsage } from "../session/rollout/usage"
import { UsageLedger } from "./ledger"
import { UsageSchema } from "./schema"
import { Lock } from "../util/lock"
import { upgradeAccessRecord } from "../migration/import"

export namespace UsageMigration {
  export const id = "20260928-independent-usage-ledger-v1"
  export const lineageMigration: Migration = {
    id: "20261003-usage-parent-index-v1",
    emptyInput: [["usage_link"]],
    scope: "derived",
    execution: "maintenance",
    description: "Index retained usage lineage by parent owner and run",
    async up(progress) {
      let completed = 0
      let after: string[] | undefined
      for (;;) {
        const rows = await Storage.query<UsageSchema.Link>({ kind: "usage_link", after, limit: 128 })
        if (!rows.length) break
        await Storage.transaction(async () => {
          for (const row of rows) {
            const current = await Storage.read<UsageSchema.Link>(row.key)
            await UsageLedger.indexLink(UsageSchema.Link.parse(current))
          }
        })
        completed += rows.length
        progress(completed, 0)
        after = rows.at(-1)!.key
      }
      progress(completed, completed)
    },
  }
  const migrations: Migration[] = [
    lineageMigration,
    {
      id,
      scope: "derived",
      execution: "after-convergence",
      description: "Schedule resumable historical usage capture without blocking runtime startup",
      async up() {
        if (!(await status())) await schedule(false, false)
      },
    },
    {
      id: "20261009-usage-response-recovery-v1",
      scope: "derived",
      execution: "after-convergence",
      dependsOn: [id],
      description: "Schedule bounded raw-response usage recovery independently of live capture checkpoints",
      async up() {
        await schedule(true, false)
      },
    },
  ]
  export function register() {
    MigrationRegistry.register("usage", migrations)
  }
  export async function status() {
    const raw = await Storage.read(StoragePath.usageRebuild(), { silentNotFound: true }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    return raw ? UsageSchema.Rebuild.parse(raw) : undefined
  }
  export async function start(restart = false) {
    return schedule(restart, true)
  }
  async function schedule(restart: boolean, requested: boolean) {
    using lock = await Lock.write("usage-rebuild")
    const previous = await status()
    if (!restart && (previous?.status === "running" || previous?.status === "pending")) {
      const resumed = { ...previous, requested }
      await Storage.write(StoragePath.usageRebuild(), resumed)
      return resumed
    }
    const result: UsageSchema.Rebuild =
      !restart && previous?.status === "failed"
        ? { ...previous, status: "pending", requested }
        : {
            version: 1,
            requested,
            status: "pending",
            phase: "indexes",
            owners: 0,
            records: 0,
            updatedAt: Date.now(),
            failures: 0,
          }
    await Storage.transaction(async () => {
      if (restart || previous?.status !== "failed") await Storage.remove(StoragePath.usageReplay())
      await Storage.write(StoragePath.usageRebuild(), result)
    })
    return result
  }
  export async function preserve(owner: UsageSchema.Owner) {
    let count = await UsageLedger.captureOwner(owner)
    let after: string[] | undefined
    do {
      const page = await preserveLegacy(owner, after)
      count += page.count
      after = page.after
    } while (after)
    return count
  }

  export async function prepare(owner: UsageSchema.Owner) {
    using lock = await Lock.write(`usage-prepare:${owner.scopeID}:${UsageLedger.ownerKey(owner)}`)
    const page = await UsageLedger.replayBatch(owner, 64, "access")
    if (!page.complete || owner.kind !== "session") return
    const key = [...StoragePath.usageReplay(), "legacy", owner.scopeID, UsageLedger.ownerKey(owner)]
    const [state] = await Storage.readMany<{ after?: string[]; complete?: boolean }>([key])
    if (state?.complete) return
    const legacy = await preserveLegacy(owner, state?.after, 16, false)
    await Storage.write(key, { after: legacy.after, complete: !legacy.after })
  }

  async function preserveLegacy(
    owner: UsageSchema.Owner,
    after?: string[],
    limit = 128,
    tools = true,
  ): Promise<{ count: number; after?: string[] }> {
    if (owner.kind !== "session") return { count: 0 }
    let count = 0
    const messages = await Storage.query<unknown>({
      kind: "message",
      scopeID: owner.scopeID,
      sessionID: owner.sessionID,
      after,
      limit,
    })
    for (const row of messages) {
      if (row.key.at(-1) !== "info") continue
      const parsed = MessageV2.Info.safeParse(upgradeAccessRecord(row.key, row.value))
      if (!parsed.success) throw new Error("Historical usage message cannot be decoded")
      const message = parsed.data
      if (message.role !== "assistant" || ["inherited", "imported"].includes(message.accounting?.kind ?? "")) continue
      if (
        (
          await Storage.queryKeys({
            prefix: [
              ...StoragePath.usageOwner(owner.scopeID, UsageLedger.ownerKey(owner)),
              message.rootID ?? message.parentID,
              "call",
            ],
            limit: 1,
          })
        ).length
      )
        continue
      if (
        message.accounting?.kind === "rollout" &&
        (await UsageLedger.hasClearedCall(owner, message.rootID ?? message.parentID, message.accounting.callIDs))
      )
        continue
      const usage = RolloutUsage.normalize("unknown", null)
      usage.input = {
        total: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write,
        uncached: message.tokens.input,
        cacheRead: message.tokens.cache.read,
        cacheWrite: message.tokens.cache.write,
      }
      usage.output = { total: message.tokens.output, reasoning: message.tokens.reasoning }
      usage.billing = "tokens"
      if (message.accounting?.kind === "rollout" && message.accounting.summary) {
        const tokens = message.accounting.summary.tokens
        usage.input = {
          total: tokens.input.total,
          uncached: tokens.uncached.total,
          cacheRead: tokens.cacheRead.total,
          cacheWrite: tokens.cacheWrite.total,
        }
        usage.output = { total: tokens.output.total, reasoning: tokens.reasoning.total }
      }
      await Storage.transaction(() =>
        UsageLedger.writeLegacy({
          owner,
          runID: message.rootID ?? message.parentID,
          entityID: message.id,
          started: message.time.created,
          ended: message.time.completed,
          status: message.time.completed ? (message.error ? "failed" : "completed") : "interrupted",
          purpose: message.agent,
          agent: message.agent,
          model: {
            providerID: message.providerID,
            modelID: message.modelID,
            sdk: "legacy",
            pricing: null,
            billingMode: "unknown",
          },
          execution: "provider",
          callKind: "chat",
          usage,
          legacyCost: message.cost,
          accounting: message.accounting?.kind === "rollout" ? message.accounting.summary : undefined,
        }),
      )
      if (tools)
        for await (const partRow of Storage.records({
          kind: "part",
          scopeID: owner.scopeID,
          sessionID: owner.sessionID,
          messageID: message.id,
        })) {
          const part = MessageV2.Part.parse(upgradeAccessRecord(partRow.key, partRow.value))
          if (part.type !== "tool") continue
          const finished =
            part.state.status === "completed" || part.state.status === "error" ? part.state.time : undefined
          const started = "time" in part.state ? part.state.time.start : message.time.created
          await Storage.transaction(() =>
            UsageLedger.writeLegacyTool({
              owner,
              runID: message.rootID ?? message.parentID,
              entityID: part.id,
              started,
              ended: finished?.end,
              tool: part.tool,
              status:
                part.state.status === "completed"
                  ? "completed"
                  : part.state.status === "error"
                    ? "failed"
                    : "interrupted",
              durationMs: finished ? Math.max(0, finished.end - finished.start) : null,
            }),
          )
        }
      count++
    }
    return { count, after: messages.length === limit ? messages.at(-1)!.key : undefined }
  }
  export async function batch(limit = 16) {
    using lock = await Lock.write("usage-rebuild")
    const current = await status()
    if (!current) throw new Error("Usage rebuild has not been scheduled")
    if (current.status === "completed" || current.status === "failed") return current
    const state = { ...current, status: "running" as UsageSchema.Rebuild["status"], updatedAt: Date.now() }
    try {
      if (!state.lineageComplete) {
        const links = await Storage.query<UsageSchema.Link>({
          kind: "usage_link",
          after: state.lineageAfter,
          limit: 128,
        })
        await Storage.transaction(async () => {
          for (const row of links) await UsageLedger.indexLink(UsageSchema.Link.parse(row.value))
          state.lineageAfter = links.at(-1)?.key ?? state.lineageAfter
          state.lineageComplete = links.length < 128
          await Storage.write(StoragePath.usageRebuild(), state)
        })
        return state
      }
      const rows = await Storage.query({
        kind: state.phase === "indexes" ? "usage" : state.phase === "sessions" ? "session" : "operations",
        after: state.after,
        orderEquals: state.phase === "operations" ? "head" : undefined,
        limit,
      })
      for (const row of rows) {
        if (state.phase === "indexes") await UsageLedger.repairIndex(UsageSchema.Record.parse(row.value))
        const isSession = state.phase === "sessions"
        if (isSession || row.key.slice(3).join("/") === "rollout/journal/head") {
          const owner: UsageSchema.Owner = isSession
            ? { kind: "session", scopeID: row.key[1], sessionID: row.key[2] }
            : { kind: "operation", scopeID: row.key[1], operationID: row.key[2] }
          const page = await UsageLedger.replayBatch(owner)
          state.records += page.processed
          if (!page.complete) {
            await Storage.write(StoragePath.usageRebuild(), state)
            return state
          }
          const legacy = await preserveLegacy(owner, state.ownerAfter)
          state.records += legacy.count
          state.ownerAfter = legacy.after
          if (legacy.after) {
            await Storage.write(StoragePath.usageRebuild(), state)
            return state
          }
          state.owners++
        }
        state.after = row.key
        await Storage.write(StoragePath.usageRebuild(), state)
      }
      if (rows.length < limit) {
        state.after = undefined
        if (state.phase === "indexes") state.phase = "sessions"
        else if (state.phase === "sessions") state.phase = "operations"
        else {
          state.phase = "completed"
          state.status = "completed"
        }
      }
    } catch (error) {
      state.status = "failed"
      state.failures++
      await Storage.write(StoragePath.usageRebuild(), state)
      throw error
    }
    await Storage.write(StoragePath.usageRebuild(), state)
    return state
  }
  export function service() {
    let stopped = false
    let wake: (() => void) | undefined
    const done = (async () => {
      while (!stopped) {
        const current = await status().catch(() => undefined)
        if (current?.requested && ["pending", "running"].includes(current.status)) {
          await batch().catch(() => {})
        }
        if (stopped) return
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, current?.requested && current.status === "running" ? 25 : 1000)
          timer.unref()
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    })()
    return async () => {
      stopped = true
      wake?.()
      await done
    }
  }
}
