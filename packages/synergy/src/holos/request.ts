import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { HolosReadiness } from "./readiness"
import { Log } from "@/util/log"

const log = Log.create({ service: "holos.request" })

export namespace HolosRequest {
  export const Capability = z.enum(["agora", "websearch", "arxiv", "profile_sync", "agent_lookup"])
  export type Capability = z.infer<typeof Capability>

  export const UnavailableError = NamedError.create(
    "HolosCapabilityUnavailableError",
    z.object({
      capability: Capability,
      reason: z.enum(["not_logged_in", "not_connected"]),
      action: z.enum(["login_holos", "reconnect_holos"]),
      message: z.string(),
    }),
  )

  const DEFAULT_TIMEOUT_MS = 30_000
  const MAX_RETRIES = 2
  const RETRY_BASE_DELAY_MS = 500

  type Options = {
    capability: Capability
    timeoutMs?: number
    retries?: number
  }

  function capabilityLabel(capability: Capability): string {
    if (capability === "agora") return "Agora access"
    if (capability === "websearch") return "Web search"
    if (capability === "arxiv") return "arXiv search"
    if (capability === "profile_sync") return "Holos profile sync"
    return "Holos agent lookup"
  }

  function unavailableError(options: Options, reason: "not_logged_in" | "not_connected") {
    const subject = capabilityLabel(options.capability)
    if (reason === "not_logged_in") {
      return new UnavailableError({
        capability: options.capability,
        reason,
        action: "login_holos",
        message: `${subject} requires Holos sign-in. Tell the user to sign in from the Holos panel (right sidebar) or by running \`synergy holos login\` in the terminal.`,
      })
    }
    return new UnavailableError({
      capability: options.capability,
      reason,
      action: "reconnect_holos",
      message: `${subject} is unavailable because the Holos connection was lost. Tell the user to click Reconnect in the Holos panel or try refreshing. If the problem persists, run \`synergy holos login\` to re-authenticate.`,
    })
  }

  function isRetryable(error: unknown): boolean {
    if (error instanceof UnavailableError) return false
    if (error instanceof DOMException && error.name === "TimeoutError") return false
    if (error instanceof DOMException && error.name === "AbortError") return false
    return true
  }

  function isRetryableResponse(response: Response): boolean {
    return response.status >= 500 || response.status === 429
  }

  export async function withBearerHeaders(headers: HeadersInit | undefined, options: Options): Promise<Headers> {
    const { credential, readiness } = await HolosReadiness.snapshot()
    if (!credential) {
      throw unavailableError(options, "not_logged_in")
    }
    if (!readiness.ready) {
      throw unavailableError(options, readiness.reason ?? "not_connected")
    }
    const merged = new Headers(headers)
    merged.set("Authorization", `Bearer ${credential.agentSecret}`)
    return merged
  }

  export async function fetch(input: string | URL, init: RequestInit | undefined, options: Options): Promise<Response> {
    const headers = await withBearerHeaders(init?.headers, options)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const hasSignal = !!init?.signal
    const signal = hasSignal ? init.signal : AbortSignal.timeout(timeoutMs)
    const maxRetries = options.retries ?? MAX_RETRIES

    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await globalThis.fetch(input, { ...init, headers, signal })
        if (isRetryableResponse(response) && attempt < maxRetries) {
          log.warn("retryable response, retrying", {
            capability: options.capability,
            status: response.status,
            attempt: attempt + 1,
          })
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** attempt))
          continue
        }
        return response
      } catch (err) {
        lastError = err
        if (!isRetryable(err) || attempt >= maxRetries) throw err
        log.warn("transient fetch error, retrying", {
          capability: options.capability,
          error: err instanceof Error ? err.message : String(err),
          attempt: attempt + 1,
        })
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** attempt))
      }
    }
    throw lastError
  }
}
