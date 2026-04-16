import { Log } from "../../../util/log"
import type { FeishuApiContext } from "./api-context"

const log = Log.create({ service: "channel.feishu.sender" })

const DEFAULT_TTL_MS = 10 * 60 * 1000
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000
const RESOLVE_TIMEOUT_MS = 5_000

function resolveIdType(senderId: string): "open_id" | "union_id" | "user_id" {
  if (senderId.startsWith("ou_")) return "open_id"
  if (senderId.startsWith("on_")) return "union_id"
  return "user_id"
}

export class SenderNameCache {
  private cache = new Map<string, { name: string; expiresAt: number }>()
  private negativeCache = new Map<string, number>()
  private ttlMs: number

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
  }

  async resolve(ctx: FeishuApiContext, senderId: string): Promise<string | undefined> {
    const normalized = senderId.trim()
    if (!normalized) return undefined

    const now = Date.now()
    const cached = this.cache.get(normalized)
    if (cached && cached.expiresAt > now) return cached.name

    const negativeCachedAt = this.negativeCache.get(normalized)
    if (negativeCachedAt !== undefined && now - negativeCachedAt < NEGATIVE_CACHE_TTL_MS) {
      return undefined
    }

    try {
      const userIdType = resolveIdType(normalized)
      const token = await ctx.getAccessToken()

      const response = await fetch(`${ctx.apiBase}/contact/v3/users/${normalized}?user_id_type=${userIdType}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      })

      const result = (await response.json()) as {
        code?: number
        msg?: string
        data?: { user?: Record<string, unknown> }
      }

      if (result.code !== 0) {
        this.negativeCache.set(normalized, now)
        if (result.code === 99991672) {
          log.warn(
            "feishu contact permission denied — grant contact:user.base:readonly scope to resolve sender names",
            {
              code: result.code,
              msg: result.msg,
            },
          )
        } else {
          log.warn("failed to resolve sender name", { senderId: normalized, code: result.code, msg: result.msg })
        }
        return undefined
      }

      const user = result.data?.user
      const name = (user?.name || user?.display_name || user?.nickname || user?.en_name) as string | undefined

      if (name && typeof name === "string") {
        this.cache.set(normalized, { name, expiresAt: now + this.ttlMs })
        this.negativeCache.delete(normalized)
        return name
      }

      this.negativeCache.set(normalized, now)
      return undefined
    } catch (err) {
      this.negativeCache.set(normalized, now)
      log.warn("failed to resolve sender name", { senderId: normalized, error: String(err) })
      return undefined
    }
  }
}

export const senderNameCache = new SenderNameCache()
