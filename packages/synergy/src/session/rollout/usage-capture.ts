import z from "zod"
import { RolloutUsage } from "./usage"

export namespace RolloutUsageCapture {
  export const MAX_EVENT_CHARS = 1024 * 1024
  type Json = z.infer<ReturnType<typeof z.json>>
  function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }

  export function create(
    sdk: string,
    mediaType: string,
    providerID?: string,
    kind?: Parameters<typeof RolloutUsage.normalize>[2],
  ) {
    const protocol: RolloutUsage.Info["protocol"] =
      sdk.includes("anthropic") || providerID === "google-vertex-anthropic"
        ? "anthropic"
        : sdk.includes("google")
          ? "google"
          : sdk.includes("openai") ||
              sdk.includes("openrouter") ||
              ["@ai-sdk/groq", "@ai-sdk/xai", "@ai-sdk/deepseek"].includes(sdk)
            ? "openai"
            : "unknown"
    const sse = mediaType.includes("text/event-stream")
    const decoder = new TextDecoder()
    let buffer = ""
    let data = ""
    let discarded = false
    let droppingLine = false
    let raw: Record<string, Json> | null = null
    let result: RolloutUsage.Info | undefined
    let serviceTier: string | undefined
    function accept(text: string) {
      if (!text || text === "[DONE]") return
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      const event = object(parsed)
      const tier = event.service_tier ?? object(event.response).service_tier
      if (typeof tier === "string") serviceTier = tier
      const candidate =
        event.usage ?? event.usageMetadata ?? object(event.message).usage ?? object(event.response).usage
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return
      const usage = z.record(z.string(), z.json()).safeParse(candidate)
      if (!usage.success) return
      raw = { ...raw, ...usage.data }
    }
    function line(value: string) {
      if (value.endsWith("\r")) value = value.slice(0, -1)
      if (!value) {
        if (!discarded) accept(data)
        data = ""
        discarded = false
        return
      }
      if (discarded || !value.startsWith("data:")) return
      const next = value.slice(5).replace(/^ /, "")
      if (data.length + next.length + 1 > MAX_EVENT_CHARS) {
        discarded = true
        data = ""
        return
      }
      data += (data ? "\n" : "") + next
    }
    function consume(text: string) {
      if (!sse) {
        if (discarded) return
        if (buffer.length + text.length > MAX_EVENT_CHARS) {
          buffer = ""
          discarded = true
          return
        }
        buffer += text
        return
      }
      let offset = 0
      while (offset < text.length) {
        const newline = text.indexOf("\n", offset)
        const end = newline < 0 ? text.length : newline
        if (!droppingLine) {
          if (buffer.length + end - offset > MAX_EVENT_CHARS) {
            buffer = ""
            data = ""
            discarded = true
            droppingLine = true
          } else buffer += text.slice(offset, end)
        }
        if (newline < 0) break
        if (!droppingLine) line(buffer)
        droppingLine = false
        buffer = ""
        offset = newline + 1
      }
    }
    return {
      append(bytes: Uint8Array) {
        if (result) throw new Error("Usage capture is already closed")
        consume(decoder.decode(bytes, { stream: true }))
      },
      finish() {
        if (result) return result
        consume(decoder.decode())
        if (sse) {
          if (buffer) line(buffer)
          if (!discarded) accept(data)
        } else if (!discarded) accept(buffer)
        result = { ...RolloutUsage.normalize(protocol, raw, kind, providerID), ...(serviceTier ? { serviceTier } : {}) }
        buffer = ""
        data = ""
        return result
      },
    }
  }
}
