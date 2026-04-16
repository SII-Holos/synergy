import z from "zod"

export namespace HolosEntitlement {
  export const QuotaStatus = z
    .enum(["available", "exhausted", "unknown", "unavailable"])
    .meta({ ref: "HolosQuotaStatus" })
  export type QuotaStatus = z.infer<typeof QuotaStatus>

  export const Quota = z
    .object({
      status: QuotaStatus,
      remaining: z.number().nullable(),
      limit: z.number().nullable(),
      reason: z.string().optional(),
    })
    .meta({ ref: "HolosQuotaInfo" })
  export type Quota = z.infer<typeof Quota>

  export const State = z
    .object({
      quotas: z.object({
        dailyFreeUsage: Quota,
      }),
    })
    .meta({ ref: "HolosEntitlementState" })
  export type State = z.infer<typeof State>

  export async function get(): Promise<State> {
    return {
      quotas: {
        dailyFreeUsage: {
          status: "unknown",
          remaining: null,
          limit: null,
          reason: "Holos quota data is not exposed yet.",
        },
      },
    }
  }
}
