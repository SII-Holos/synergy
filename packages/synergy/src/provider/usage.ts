import { Auth } from "./api-key"
import z from "zod"

export namespace AccountUsage {
  export type Kind = "codex" | "anthropic-oauth" | "openrouter" | "unsupported"

  export const Window = z
    .object({
      label: z.string(),
      usedPercent: z.number().min(0).optional(),
      remainingPercent: z.number().min(0).max(100).optional(),
      resetAt: z.string().optional(),
      detail: z.string().optional(),
    })
    .meta({ ref: "AccountUsageWindow" })
  export type Window = z.infer<typeof Window>

  export const Credits = z
    .object({
      hasCredits: z.boolean().optional(),
      balance: z.number().optional(),
      unlimited: z.boolean().optional(),
      currency: z.string().optional(),
    })
    .meta({ ref: "AccountUsageCredits" })
  export type Credits = z.infer<typeof Credits>

  export const Snapshot = z
    .object({
      providerID: z.string(),
      status: z.enum(["available", "unavailable", "error"]),
      source: z.string().optional(),
      fetchedAt: z.string(),
      plan: z.string().optional(),
      windows: z.array(Window),
      details: z.array(z.string()),
      credits: Credits.optional(),
      reloginRequired: z.boolean().optional(),
      unavailableReason: z.string().optional(),
    })
    .meta({ ref: "AccountUsageSnapshot" })
  export type Snapshot = z.infer<typeof Snapshot>

  export function unavailable(providerID: string, unavailableReason: string, input?: Partial<Snapshot>): Snapshot {
    return {
      providerID,
      status: "unavailable",
      fetchedAt: new Date().toISOString(),
      windows: [],
      details: [],
      unavailableReason,
      ...input,
    }
  }

  export function error(providerID: string, unavailableReason: string, input?: Partial<Snapshot>): Snapshot {
    return unavailable(providerID, unavailableReason, {
      status: "error",
      ...input,
    })
  }

  export function percentWindow(input: {
    label: string
    usedPercent?: unknown
    resetAt?: unknown
    detail?: string
  }): Window | undefined {
    if (input.usedPercent === undefined || input.usedPercent === null) return undefined
    const usedPercent = Number(input.usedPercent)
    if (!Number.isFinite(usedPercent)) return undefined
    const clamped = Math.max(0, Math.min(100, usedPercent))
    const resetAt = typeof input.resetAt === "string" && input.resetAt ? input.resetAt : undefined
    return {
      label: input.label,
      usedPercent: clamped,
      remainingPercent: Math.max(0, 100 - clamped),
      resetAt,
      detail: input.detail,
    }
  }

  export async function openrouter(providerID = "openrouter", fetchFn: typeof fetch = fetch): Promise<Snapshot> {
    const auth = await Auth.get(providerID)
    if (!auth || auth.type !== "api") {
      return unavailable(providerID, "OpenRouter credits are only available for API-key credentials.")
    }
    const headers = {
      Authorization: `Bearer ${auth.key}`,
      Accept: "application/json",
    }
    const [creditsResponse, keyResponse] = await Promise.all([
      fetchFn("https://openrouter.ai/api/v1/credits", {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetchFn("https://openrouter.ai/api/v1/key", {
        headers,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined),
    ])
    if (!creditsResponse.ok) {
      return error(providerID, `OpenRouter credits request failed with status ${creditsResponse.status}.`)
    }
    const creditsPayload = (await creditsResponse.json().catch(() => ({}))) as any
    const keyPayload = keyResponse?.ok ? ((await keyResponse.json().catch(() => ({}))) as any) : {}
    const credits = creditsPayload.data ?? {}
    const key = keyPayload.data ?? {}
    const totalCredits = Number(credits.total_credits ?? 0)
    const totalUsage = Number(credits.total_usage ?? 0)
    const details: string[] = []
    if (Number.isFinite(totalCredits) && Number.isFinite(totalUsage)) {
      details.push(`Credits balance: $${Math.max(0, totalCredits - totalUsage).toFixed(2)}`)
    }
    const windows: Window[] = []
    const limit = Number(key.limit)
    const remaining = Number(key.limit_remaining)
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
      const used = ((limit - remaining) / limit) * 100
      windows.push({
        label: "API key quota",
        usedPercent: Math.max(0, Math.min(100, used)),
        remainingPercent: Math.max(0, Math.min(100, (remaining / limit) * 100)),
        detail: `$${remaining.toFixed(2)} of $${limit.toFixed(2)} remaining`,
      })
    }
    if (typeof key.usage === "number") details.push(`API key usage: $${key.usage.toFixed(2)} total`)
    return {
      providerID,
      status: "available",
      source: "credits_api",
      fetchedAt: new Date().toISOString(),
      windows,
      details,
      credits: {
        hasCredits: Number.isFinite(totalCredits) && totalCredits > totalUsage,
        balance:
          Number.isFinite(totalCredits) && Number.isFinite(totalUsage)
            ? Math.max(0, totalCredits - totalUsage)
            : undefined,
        currency: "USD",
      },
    }
  }
}
