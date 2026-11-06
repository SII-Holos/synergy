import z from "zod"
import { RolloutUsage } from "./usage"

export namespace RolloutUsageCapture {
  export const MAX_EVENT_CHARS = 1024 * 1024
  const sseFields = ["data:", "event:", "id:", "retry:", ":"]
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
    onContent?: (reasoning: boolean) => void,
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
    const declaredSSE = mediaType.split(";", 1)[0].trim().toLowerCase() === "text/event-stream"
    let format: "sse" | "json" | "unknown" | undefined
    let probe = ""
    let skipLF = false
    const decoder = new TextDecoder()
    let buffer = ""
    let data = ""
    let discarded = false
    let droppingLine = false
    let raw: Record<string, Json> | null = null
    let result: RolloutUsage.Info | undefined
    let serviceTier: string | undefined
    let final = false
    let responseModel: string | undefined
    function accept(text: string) {
      if (!text || text === "[DONE]") return
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      const event = object(parsed)
      const name = event.model ?? object(event.response).model ?? object(event.message).model ?? event.modelVersion
      if (typeof name === "string" && name.length <= 256) responseModel = name
      if (["response.completed", "response.incomplete", "message_stop"].includes(String(event.type))) final = true
      if (object(event.delta).stop_reason) final = true
      if (
        Array.isArray(event.choices) &&
        event.usage &&
        (!event.choices.length || event.choices.some((choice) => object(choice).finish_reason))
      )
        final = true
      if (Array.isArray(event.candidates) && event.candidates.some((candidate) => object(candidate).finishReason))
        final = true
      const nonempty = (value: unknown) => typeof value === "string" && value.length > 0
      const deltas = Array.isArray(event.choices) ? event.choices.map((choice) => object(object(choice).delta)) : []
      const delta = object(event.delta)
      const parts = Array.isArray(event.candidates)
        ? event.candidates.flatMap((candidate) => {
            const parts = object(object(candidate).content).parts
            return Array.isArray(parts) ? parts.map(object) : []
          })
        : []
      const reasoning =
        deltas.some((item) => nonempty(item.reasoning_content) || nonempty(item.reasoning)) ||
        nonempty(delta.thinking) ||
        parts.some((part) => part.thought === true && nonempty(part.text)) ||
        (typeof event.type === "string" && event.type.includes("reasoning") && nonempty(event.delta))
      const content =
        reasoning ||
        deltas.some(
          (item) =>
            nonempty(item.content) ||
            (Array.isArray(item.tool_calls) &&
              item.tool_calls.some((tool) => {
                const fn = object(object(tool).function)
                return nonempty(fn.arguments) || nonempty(fn.name)
              })),
        ) ||
        nonempty(delta.text) ||
        nonempty(delta.partial_json) ||
        parts.some((part) => nonempty(part.text) || Object.keys(object(part.functionCall)).length > 0) ||
        (["response.output_text.delta", "response.function_call_arguments.delta"].includes(String(event.type)) &&
          nonempty(event.delta))
      if (content && format === "sse") onContent?.(reasoning)
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
      if (format === undefined) {
        let offset = 0
        while (offset < text.length && format === undefined) {
          const char = text[offset++]
          if (!probe && /\s/.test(char)) continue
          probe += char
          if (probe === "{" || probe === "[") format = "json"
          else if (declaredSSE || sseFields.includes(probe)) format = "sse"
          else if (!sseFields.some((field) => field.startsWith(probe))) format = "unknown"
        }
        if (format === undefined) return
        text = probe + text.slice(offset)
        probe = ""
      }
      if (format === "unknown") return
      if (format === "json") {
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
      const endings = /[\r\n]/g
      while (offset < text.length) {
        if (skipLF) {
          if (text[offset] === "\n") offset++
          skipLF = false
          if (offset === text.length) break
        }
        endings.lastIndex = offset
        const newline = endings.exec(text)?.index ?? -1
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
        skipLF = text[newline] === "\r"
        offset = newline + 1
      }
    }
    return {
      responseModel() {
        return responseModel
      },
      hasUsage() {
        return raw !== null
      },
      hasFinalUsage() {
        return raw !== null && final
      },
      get streaming() {
        return format === "sse"
      },
      current() {
        return raw
          ? { ...RolloutUsage.normalize(protocol, raw, kind, providerID), ...(serviceTier ? { serviceTier } : {}) }
          : undefined
      },
      append(bytes: Uint8Array) {
        if (result) throw new Error("Usage capture is already closed")
        consume(decoder.decode(bytes, { stream: true }))
      },
      finish() {
        if (result) return result
        consume(decoder.decode())
        if (format === "sse") {
          if (buffer) line(buffer)
          if (!discarded) accept(data)
        } else if (format === "json" && !discarded) accept(buffer)
        result = { ...RolloutUsage.normalize(protocol, raw, kind, providerID), ...(serviceTier ? { serviceTier } : {}) }
        buffer = ""
        data = ""
        return result
      },
    }
  }
}
