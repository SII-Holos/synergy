import z from "zod"

export namespace PushTypes {
  export const Categories = z
    .object({
      completion: z.boolean(),
      error: z.boolean(),
      input: z.boolean(),
    })
    .meta({ ref: "PushCategories" })
  export type Categories = z.infer<typeof Categories>

  export const DEFAULT_CATEGORIES: Categories = { completion: true, error: true, input: true }

  export const Subscription = z
    .object({
      id: z.string(),
      endpoint: z.string().url(),
      keys: z.object({ p256dh: z.string(), auth: z.string() }),
      deviceLabel: z.string().optional(),
      created: z.number(),
      categories: Categories,
    })
    .meta({ ref: "PushSubscription" })
  export type Subscription = z.infer<typeof Subscription>

  export const SubscribeInput = z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
    deviceLabel: z.string().optional(),
    categories: Categories.optional(),
  })
  export type SubscribeInput = z.infer<typeof SubscribeInput>

  export const UnsubscribeInput = z.object({
    endpoint: z.string().url(),
  })

  export const Payload = z.object({
    title: z.string(),
    body: z.string(),
    href: z.string(),
    tag: z.string(),
    category: z.enum(["completion", "error", "input", "test"]),
    badge: z.number().int().nonnegative().optional(),
  })
  export type Payload = z.infer<typeof Payload>

  /**
   * Web Push endpoints are attacker-controllable URLs; the server POSTs the
   * encrypted payload to them, so only known browser push service hosts are
   * accepted (SSRF boundary for /push/subscribe).
   */
  export function isAllowedPushEndpoint(endpoint: string): boolean {
    let parsed: URL
    try {
      parsed = new URL(endpoint)
    } catch {
      return false
    }
    if (parsed.protocol !== "https:") return false
    const host = parsed.hostname
    return (
      host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" || host.endsWith(".push.apple.com")
    )
  }
}
