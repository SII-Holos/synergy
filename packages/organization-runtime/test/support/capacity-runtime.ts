import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoreTransaction, type RecordQuery } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { RuntimeIdentity } from "../../src/home"
import { openHostedRuntime, openMemberRuntime } from "../../src/runtime"
import { OrganizationSyncPath as Keys } from "../../src/storage/path"

export function messageChecksum(id: string) {
  return BigInt(`0x${createHash("sha256").update(id).digest("hex")}`)
}

export function measureOwnedProcessMemory() {
  const owned = new Map<
    number,
    { alive: () => boolean; identity?: string; peakRSS: number; samples: number; missing: number; changed: boolean }
  >()
  const controller = new AbortController()
  let pending: Promise<void> | undefined
  let closed = false
  async function sample() {
    if (closed) return
    if (pending) return pending
    pending = (async () => {
      const active = [...owned].filter(([, entry]) => entry.alive())
      const values = await ProcessInspection.sampleBatch(
        active.map(([pid]) => pid),
        { signal: controller.signal },
      )
      if (closed) return
      for (const [pid, entry] of active) {
        const value = values.get(pid)
        if (!value || !entry.alive()) {
          entry.missing++
          continue
        }
        if (entry.identity !== undefined && entry.identity !== value.identity) {
          entry.changed = true
          continue
        }
        entry.identity = value.identity
        entry.peakRSS = Math.max(entry.peakRSS, value.rssBytes)
        entry.samples++
      }
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
  const timer = setInterval(() => {
    void sample()
  }, 250)
  timer.unref()
  return {
    own(pid: number, alive: () => boolean) {
      if (closed || owned.has(pid)) throw new Error("Capacity process sampling requires a unique live owned process")
      owned.set(pid, { alive, peakRSS: 0, samples: 0, missing: 0, changed: false })
      void sample()
    },
    async snapshot() {
      await sample()
      return [...owned].map(([pid, entry]) => ({
        pid,
        peakRSS: entry.peakRSS,
        samples: entry.samples,
        missing: entry.missing,
        identityChanged: entry.changed,
        source: "os_process_inspection" as const,
        intervalMs: 250,
      }))
    },
    async [Symbol.asyncDispose]() {
      closed = true
      clearInterval(timer)
      controller.abort()
      await pending
    },
  }
}

export function measureCapacity() {
  const ranges = new Map<string, { calls: number; maxRows: number; maxLimit: number; unbounded: number }>()
  let maxReadMany = 0
  let peakRSS = 0
  let peakHeap = 0
  let enabled = false
  const query = StoreTransaction.prototype.query
  const readMany = StoreTransaction.prototype.readMany
  function memory() {
    const usage = process.memoryUsage()
    peakRSS = Math.max(peakRSS, usage.rss, process.resourceUsage().maxRSS * 1024)
    peakHeap = Math.max(peakHeap, usage.heapUsed)
  }
  StoreTransaction.prototype.query = async function <T>(input: RecordQuery) {
    const original = query<T>
    const rows = await original.call(this, input)
    if (enabled) {
      const key = JSON.stringify({
        prefix: input.prefix?.slice(0, 2),
        depth: input.prefix?.length,
        kind: input.kind,
        scope: Boolean(input.scopeID),
        session: Boolean(input.sessionID),
        message: Boolean(input.messageID),
        cursor: Boolean(input.after),
        descending: Boolean(input.descending),
      })
      const current = ranges.get(key) ?? { calls: 0, maxRows: 0, maxLimit: 0, unbounded: 0 }
      current.calls++
      current.maxRows = Math.max(current.maxRows, rows.length)
      current.maxLimit = Math.max(current.maxLimit, input.limit ?? 0)
      current.unbounded += input.limit === undefined ? 1 : 0
      ranges.set(key, current)
    }
    return rows
  }
  StoreTransaction.prototype.readMany = async function <T = unknown>(keys: string[][]) {
    if (enabled) maxReadMany = Math.max(maxReadMany, keys.length)
    const original = readMany<T>
    return original.call(this, keys)
  }
  const timer = setInterval(memory, 50)
  timer.unref()
  memory()
  return {
    begin() {
      ranges.clear()
      maxReadMany = 0
      enabled = true
    },
    snapshot() {
      memory()
      return {
        pid: process.pid,
        peakRSS,
        peakHeap,
        maxReadMany,
        ranges: [...ranges].map(([selector, value]) => ({ selector, ...value })),
      }
    },
    [Symbol.dispose]() {
      clearInterval(timer)
      StoreTransaction.prototype.query = query
      StoreTransaction.prototype.readMany = readMany
    },
  }
}

export const CapacityMetrics = z.object({
  pid: z.number(),
  peakRSS: z.number(),
  peakHeap: z.number(),
  maxReadMany: z.number(),
  ranges: z.array(
    z.object({
      selector: z.string(),
      calls: z.number(),
      maxRows: z.number(),
      maxLimit: z.number(),
      unbounded: z.number(),
    }),
  ),
})
export const WrittenHistory = z.object({
  sessionID: z.string(),
  count: z.number(),
  checksum: z.string(),
  lastMessageID: z.string(),
  attachment: z.object({ hash: z.string(), bytes: z.number(), chunks: z.number() }).optional(),
})
export const CapacityBacklog = z.object({
  sessions: z.number(),
  drafts: z.number(),
  pendingBatches: z.number(),
  synced: z.number(),
  metrics: CapacityMetrics,
})
const Request = z.discriminatedUnion("operation", [
  z.object({
    id: z.string(),
    operation: z.literal("append"),
    sessions: z
      .array(
        z.object({
          sessionID: z.string(),
          count: z.number().int().min(1).max(10000),
          attachment: z.boolean().optional(),
        }),
      )
      .max(100),
  }),
  z.object({ id: z.string(), operation: z.literal("backlog"), sessions: z.array(z.string()).max(100) }),
  z.object({ id: z.string(), operation: z.literal("close") }),
])
export type CapacityRequest = z.infer<typeof Request>
export const CapacityReply = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), pid: z.number() }),
  z.object({
    type: z.literal("progress"),
    id: z.string(),
    completed: z.number(),
    total: z.number(),
    elapsedMs: z.number(),
    peakRSS: z.number(),
    peakHeap: z.number(),
  }),
  z.object({ type: z.literal("result"), id: z.string(), result: z.unknown() }),
  z.object({ type: z.literal("failed"), id: z.string().optional(), message: z.string() }),
])

async function main() {
  const input = z
    .object({ home: z.string(), identity: RuntimeIdentity, ca: z.string() })
    .parse(JSON.parse(process.env.SYNERGY_CAPACITY_RUNTIME!))
  using metrics = measureCapacity()
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  const listen = { port, token: randomBytes(32).toString("hex") }
  const runtime =
    "accountID" in input.identity
      ? await openMemberRuntime({ ...input, identity: input.identity, listen })
      : await openHostedRuntime({ ...input, identity: input.identity, listen })
  metrics.begin()
  const finished = Promise.withResolvers<void>()
  let tail = Promise.resolve()
  process.on("message", (raw: unknown) => {
    tail = tail
      .then(async () => {
        const request = Request.parse(raw)
        try {
          if (request.operation === "close") {
            await runtime.close()
            process.send?.({ type: "result", id: request.id, result: metrics.snapshot() })
            finished.resolve()
            return
          }
          const result = await runtime.run(async () => {
            if (request.operation === "backlog") {
              let drafts = 0
              let pendingBatches = 0
              let synced = 0
              for (const sessionID of request.sessions) {
                drafts += await Storage.count({ prefix: Keys.drafts(input.identity.orgID, sessionID) })
                const [state, batch] = await Storage.readMany<unknown>([
                  Keys.state(input.identity.orgID, sessionID),
                  Keys.batch(input.identity.orgID, sessionID),
                ])
                if (batch) pendingBatches++
                if (z.object({ syncState: z.string() }).optional().parse(state)?.syncState === "synced") synced++
              }
              return { sessions: request.sessions.length, drafts, pendingBatches, synced, metrics: metrics.snapshot() }
            }
            const written: z.infer<typeof WrittenHistory>[] = []
            for (const entry of request.sessions) {
              const session = await Session.get(entry.sessionID)
              await ScopeContext.provide({
                scope: session.scope,
                workspace: session.workspace,
                fn: async () => {
                  let checksum = 0n
                  let lastMessageID = ""
                  const started = performance.now()
                  for (let offset = 0; offset < entry.count; offset += 100) {
                    const end = Math.min(entry.count, offset + 100)
                    await Storage.transaction(async () => {
                      for (let index = offset; index < end; index++) {
                        const messageID = Identifier.ascending("message")
                        lastMessageID = messageID
                        checksum ^= messageChecksum(messageID)
                        await Session.updateMessage({
                          id: messageID,
                          sessionID: session.id,
                          role: "user",
                          agent: "general",
                          model: { providerID: "capacity-fixture", modelID: "canonical-producer" },
                          time: { created: Date.now() },
                        })
                        await Session.updatePart({
                          id: Identifier.ascending("part"),
                          sessionID: session.id,
                          messageID,
                          type: "text",
                          text: `Capacity message ${index}: retained canonical history`,
                        })
                      }
                    })
                    await Session.flushPartWrites(session.id)
                    if (entry.count >= 1000 && end % 1000 === 0) {
                      const memory = metrics.snapshot()
                      process.send?.({
                        type: "progress",
                        id: request.id,
                        completed: end,
                        total: entry.count,
                        elapsedMs: performance.now() - started,
                        peakRSS: memory.peakRSS,
                        peakHeap: memory.peakHeap,
                      })
                    }
                  }
                  let attachment: z.infer<typeof WrittenHistory>["attachment"]
                  if (entry.attachment) {
                    const bytes = 8 * 1024 * 1024 + 17
                    const artifact = await RolloutArtifact.write(
                      { kind: "session", scopeID: session.scope.id, sessionID: session.id },
                      (async function* () {
                        for (let offset = 0; offset < bytes; offset += 65536)
                          yield Buffer.alloc(Math.min(65536, bytes - offset), (offset / 65536) % 251)
                      })(),
                      "application/octet-stream",
                    )
                    if (!artifact.sha256) throw new Error("Canonical attachment has no completed hash")
                    attachment = { hash: artifact.sha256, bytes: artifact.bytes, chunks: artifact.chunks }
                    await Session.updatePart({
                      id: Identifier.ascending("part"),
                      sessionID: session.id,
                      messageID: lastMessageID,
                      type: "attachment",
                      artifact,
                      filename: "capacity.bin",
                      mime: "application/octet-stream",
                      url: "attachment://capacity",
                    })
                  }
                  await Session.flushPartWrites(session.id)
                  written.push({
                    sessionID: session.id,
                    count: entry.count,
                    checksum: checksum.toString(16).padStart(64, "0"),
                    lastMessageID,
                    ...(attachment ? { attachment } : {}),
                  })
                },
              })
            }
            return written
          })
          process.send?.({ type: "result", id: request.id, result })
        } catch (error) {
          process.send?.({
            type: "failed",
            id: request.id,
            message: error instanceof Error ? (error.stack ?? error.message) : String(error),
          })
        }
      })
      .catch((error) => finished.reject(error))
  })
  process.send?.({ type: "ready", pid: process.pid })
  try {
    await finished.promise
  } finally {
    process.disconnect?.()
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.send?.({ type: "failed", message: error instanceof Error ? error.stack : String(error) })
    process.exitCode = 1
    process.disconnect?.()
  })
}
