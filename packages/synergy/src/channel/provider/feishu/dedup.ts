import { Storage } from "../../../storage/storage"
import { Log } from "../../../util/log"

const log = Log.create({ service: "channel.feishu.dedup" })

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MEMORY_MAX_SIZE = 1000

interface DedupEntry {
  seenAt: number
}

export class FeishuDedup {
  private readonly ttlMs: number
  private readonly memoryMaxSize: number
  private readonly memory = new Map<string, number>()

  constructor(opts?: { ttlMs?: number; memoryMaxSize?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
    this.memoryMaxSize = opts?.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE
  }

  async isDuplicate(accountId: string, messageId: string): Promise<boolean> {
    if (!messageId) {
      log.warn("message has no messageId, cannot deduplicate")
      return false
    }

    const memoryKey = `${accountId}:${messageId}`
    const now = Date.now()

    const memorySeen = this.memory.get(memoryKey)
    if (memorySeen !== undefined && now - memorySeen <= this.ttlMs) {
      log.info("duplicate detected in memory", { accountId, messageId })
      return true
    }

    try {
      const entry = await Storage.read<DedupEntry>(this.storageKey(accountId, messageId))
      if (now - entry.seenAt <= this.ttlMs) {
        this.memory.set(memoryKey, entry.seenAt)
        log.info("duplicate detected in storage", { accountId, messageId })
        return true
      }
      // Expired in storage — clean it up
      await Storage.remove(this.storageKey(accountId, messageId))
    } catch {
      // NotFoundError — not a duplicate
    }

    this.memory.set(memoryKey, now)
    this.pruneMemory()

    await Storage.write<DedupEntry>(this.storageKey(accountId, messageId), { seenAt: now }).catch((err) =>
      log.error("failed to persist dedup entry", { accountId, messageId, error: err }),
    )

    return false
  }

  async warmup(accountId: string): Promise<number> {
    await this.pruneStorage(accountId)

    const messageIds = await Storage.scan(["channel", "dedup", accountId])
    const now = Date.now()
    let loaded = 0

    for (const messageId of messageIds) {
      try {
        const entry = await Storage.read<DedupEntry>(this.storageKey(accountId, messageId))
        if (now - entry.seenAt <= this.ttlMs) {
          this.memory.set(`${accountId}:${messageId}`, entry.seenAt)
          loaded++
        }
      } catch {
        // Entry unreadable — skip
      }
    }

    log.info("warmup complete", { accountId, loaded })
    return loaded
  }

  private pruneMemory() {
    const now = Date.now()

    for (const [key, timestamp] of this.memory) {
      if (now - timestamp > this.ttlMs) {
        this.memory.delete(key)
      }
    }

    if (this.memory.size > this.memoryMaxSize) {
      const entries = [...this.memory.entries()].sort((a, b) => a[1] - b[1])
      const excess = this.memory.size - this.memoryMaxSize
      for (let i = 0; i < excess; i++) {
        this.memory.delete(entries[i][0])
      }
    }
  }

  private async pruneStorage(accountId: string) {
    const messageIds = await Storage.scan(["channel", "dedup", accountId])
    const now = Date.now()
    let pruned = 0

    for (const messageId of messageIds) {
      try {
        const entry = await Storage.read<DedupEntry>(this.storageKey(accountId, messageId))
        if (now - entry.seenAt > this.ttlMs) {
          await Storage.remove(this.storageKey(accountId, messageId))
          pruned++
        }
      } catch {
        await Storage.remove(this.storageKey(accountId, messageId))
        pruned++
      }
    }

    if (pruned > 0) {
      log.info("pruned expired storage entries", { accountId, pruned })
    }
  }

  private storageKey(accountId: string, messageId: string): string[] {
    return ["channel", "dedup", accountId, messageId]
  }
}

export const feishuDedup = new FeishuDedup()
