import type { APICallError, ModelMessage } from "ai"
import { unique } from "remeda"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { PromptCachePolicy } from "./prompt-cache-policy"
import { iife } from "@/util/iife"

const BEDROCK_MAX_IMAGE_BYTES = 5 * 1024 * 1024

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export namespace ProviderTransform {
  interface SchemaOptions {
    tool?: string
  }

  interface MessageOptions {
    systemCacheBreakpoint?: number
  }

  export function sanitizeSurrogates(content: string) {
    return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
  }

  function normalizeMessages(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    // Sanitize surrogate characters in all messages
    msgs = msgs.map((msg) => {
      if (typeof msg.content === "string") {
        msg.content = sanitizeSurrogates(msg.content)
        return msg
      }
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ("text" in part && typeof (part as any).text === "string") {
            ;(part as any).text = sanitizeSurrogates((part as any).text)
          }
        }
      }
      return msg
    })

    // Anthropic and Bedrock reject messages with empty content
    if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/amazon-bedrock") {
      msgs = msgs
        .map((msg) => {
          if (typeof msg.content === "string") {
            if (msg.content === "") return undefined
            return msg
          }
          if (!Array.isArray(msg.content)) return msg
          const filtered = msg.content.filter((part) => {
            if (part.type === "text" || part.type === "reasoning") {
              return part.text !== ""
            }
            return true
          })
          if (filtered.length === 0) return undefined
          return { ...msg, content: filtered }
        })
        .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
    }

    if (model.api.id.includes("claude")) {
      const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
      msgs = msgs.map((msg) => {
        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          })
        }
        return msg
      })
    }

    // Anthropic rejects assistant turns where tool_use blocks are followed by non-tool content
    if (["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"].includes(model.api.npm)) {
      msgs = msgs.flatMap((msg) => {
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [msg]
        const parts = msg.content
        const first = parts.findIndex((part) => part.type === "tool-call")
        if (first === -1) return [msg]
        if (!parts.slice(first).some((part) => part.type !== "tool-call")) return [msg]
        return [
          { ...msg, content: parts.filter((part) => part.type !== "tool-call") },
          { ...msg, content: parts.filter((part) => part.type === "tool-call") },
        ]
      })
    }

    if (
      model.providerID === "mistral" ||
      model.api.id.toLowerCase().includes("mistral") ||
      model.api.id.toLowerCase().includes("devstral")
    ) {
      const result: ModelMessage[] = []
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const nextMsg = msgs[i + 1]

        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              // Mistral requires alphanumeric tool call IDs with exactly 9 characters
              const normalizedId = part.toolCallId
                .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
                .substring(0, 9) // Take first 9 characters
                .padEnd(9, "0") // Pad with zeros if less than 9 characters

              return {
                ...part,
                toolCallId: normalizedId,
              }
            }
            return part
          })
        }

        result.push(msg)

        // Fix message sequence: tool messages cannot be followed by user messages
        if (msg.role === "tool" && nextMsg?.role === "user") {
          result.push({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          })
        }
      }
      return result
    }

    if (
      model.capabilities.interleaved &&
      typeof model.capabilities.interleaved === "object" &&
      model.capabilities.interleaved.field === "reasoning_content"
    ) {
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          // DeepSeek requires reasoning_content on ALL assistant messages in
          // thinking mode when tool calls are present in the conversation — even
          // if the current message produced no reasoning. Omitting it triggers:
          // "The reasoning_content in the thinking mode must be passed back to the API."
          return {
            ...msg,
            content: filteredContent,
            providerOptions: {
              ...msg.providerOptions,
              openaiCompatible: {
                ...(msg.providerOptions as any)?.openaiCompatible,
                reasoning_content: reasoningText || "",
              },
            },
          }
        }

        return msg
      })
    }

    return msgs
  }

  function applyCaching(msgs: ModelMessage[], providerID: string, options?: MessageOptions): ModelMessage[] {
    const selected: ModelMessage[] =
      options?.systemCacheBreakpoint === undefined
        ? [
            ...msgs.filter((msg) => msg.role === "system").slice(0, 2),
            ...msgs.filter((msg) => msg.role !== "system").slice(-2),
          ]
        : [msgs.filter((msg) => msg.role === "system")[options.systemCacheBreakpoint]].filter(
            (msg) => msg !== undefined,
          )

    const providerOptions = {
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
      openrouter: {
        cacheControl: { type: "ephemeral" },
      },
      bedrock: {
        cachePoint: { type: "ephemeral" },
      },
      openaiCompatible: {
        cache_control: { type: "ephemeral" },
      },
    }

    for (const msg of unique(selected)) {
      const shouldUseContentOptions = providerID !== "anthropic" && Array.isArray(msg.content) && msg.content.length > 0

      if (shouldUseContentOptions) {
        const lastContent = msg.content[msg.content.length - 1]
        if (lastContent && typeof lastContent === "object") {
          lastContent.providerOptions = {
            ...lastContent.providerOptions,
            ...providerOptions,
          }
          continue
        }
      }

      msg.providerOptions = {
        ...msg.providerOptions,
        ...providerOptions,
      }
    }

    return msgs
  }

  function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      let hasSupportedImage = false
      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part

        const attachment = attachmentInfo(part)
        if (!attachment) return part

        if (attachment.modality === "image" && attachment.dataUrl) {
          if (attachment.base64.length === 0) {
            return invalidImagePart()
          }
          if (
            model.api.npm === "@ai-sdk/amazon-bedrock" &&
            decodedByteLength(attachment.base64) > BEDROCK_MAX_IMAGE_BYTES
          ) {
            const name = attachment.filename ? `"${attachment.filename}"` : "image"
            return {
              type: "text" as const,
              text: `[${name} was attached but not sent to Bedrock because it exceeds the 5MB image limit. Use view_image with a smaller local image when the active model supports image input, use look_at for separate vision-model analysis, or attach a smaller image.]`,
            }
          }
        }

        if (model.capabilities.input[attachment.modality]) {
          hasSupportedImage = true
          return part
        }

        const name = attachment.filename ? `"${attachment.filename}"` : attachment.modality
        return {
          type: "text" as const,
          text: `[${name} was attached but this model does not support ${attachment.modality} input. Use the look_at tool with the file's local path to analyze it.]`,
        }
      })

      if (hasSupportedImage) {
        const hint = {
          type: "text" as const,
          text: "[The image(s) in this message are already embedded in the conversation context. You can analyze them directly without calling view_image.]",
        }
        return { ...msg, content: [hint, ...filtered] }
      }

      return { ...msg, content: filtered }
    })
  }

  function attachmentInfo(part: any):
    | {
        modality: Modality
        mime: string
        filename?: string
        dataUrl?: string
        base64: string
      }
    | undefined {
    if (part.type === "image") {
      const imageStr = part.image.toString()
      const data = parseDataUrl(imageStr)
      return {
        modality: "image",
        mime: data?.mime ?? imageStr.split(";")[0].replace("data:", ""),
        dataUrl: data?.url,
        base64: data?.base64 ?? "",
      }
    }

    const mime = part.mediaType
    const modality = mimeToModality(mime)
    if (!modality) return undefined
    const data = typeof part.data === "string" ? parseDataUrl(part.data) : undefined
    return {
      modality,
      mime,
      filename: part.filename,
      dataUrl: data?.url,
      base64: data?.base64 ?? "",
    }
  }

  function parseDataUrl(value: string) {
    const match = value.match(/^data:([^;]+);base64,(.*)$/)
    if (!match) return undefined
    return {
      url: value,
      mime: match[1],
      base64: match[2],
    }
  }

  function decodedByteLength(base64: string) {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
    return Math.floor((base64.length * 3) / 4) - padding
  }

  function invalidImagePart() {
    return {
      type: "text" as const,
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    }
  }

  export function message(msgs: ModelMessage[], model: Provider.Model, options?: MessageOptions) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model)
    if (
      model.providerID === "anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic"
    ) {
      msgs = applyCaching(msgs, model.providerID, options)
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen3.5")) return 0.6
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      if (id.includes("thinking")) return 1.0
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen3.5")) return 0.95
    if (id.includes("qwen")) return 1
    if (id.includes("minimax-m2")) {
      return 0.95
    }
    if (id.includes("gemini")) return 0.95
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen3.5")) return 20
    if (id.includes("minimax-m2")) {
      if (id.includes("m2.1")) return 40
      return 20
    }
    if (id.includes("gemini")) return 64
    return undefined
  }

  const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
  const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh", "max", "ultra"]

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    if (!model.capabilities.reasoning) return {}

    const id = model.id.toLowerCase()
    if (id.includes("deepseek") || id.includes("minimax") || id.includes("glm") || id.includes("mistral")) return {}

    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider":
        if (!model.id.includes("gpt") && !model.id.includes("gemini-3") && !model.id.includes("grok-4")) return {}
        return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoning: { effort } }]))

      // TODO: YOU CANNOT SET max_tokens if this is set!!!
      case "@ai-sdk/gateway":
        return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/cerebras":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
      case "@ai-sdk/togetherai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
      case "@ai-sdk/xai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
      case "@ai-sdk/deepinfra":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
      case "@ai-sdk/openai-compatible":
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/azure":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
        if (id === "o1-mini") return {}
        const azureEfforts = ["low", "medium", "high"]
        if (id.includes("gpt-5-") || id === "gpt-5") {
          azureEfforts.unshift("minimal")
        }
        if (model.release_date >= "2025-11-13") {
          azureEfforts.unshift("none")
        }
        if (model.release_date >= "2025-12-04") {
          azureEfforts.push("xhigh")
        }
        if (model.release_date >= "2026-07-01") {
          azureEfforts.push("max", "ultra")
        }
        return Object.fromEntries(
          azureEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )
      case "@ai-sdk/openai":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
        if (id === "gpt-5-pro") return {}
        const openaiEfforts = iife(() => {
          if (id.includes("codex")) return WIDELY_SUPPORTED_EFFORTS
          const arr = [...WIDELY_SUPPORTED_EFFORTS]
          if (id.includes("gpt-5-") || id === "gpt-5") {
            arr.unshift("minimal")
          }
          if (model.release_date >= "2025-11-13") {
            arr.unshift("none")
          }
          if (model.release_date >= "2025-12-04") {
            arr.push("xhigh")
          }
          if (model.release_date >= "2026-07-01") {
            arr.push("max", "ultra")
          }
          return arr
        })
        return Object.fromEntries(
          openaiEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )

      case "@ai-sdk/anthropic":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
        if (["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) => model.api.id.includes(v))) {
          return Object.fromEntries(
            ["low", "medium", "high", "max"].map((effort) => [effort, { thinking: { type: "adaptive" }, effort }]),
          )
        }
        if (["opus-4-7", "opus-4.7"].some((v) => model.api.id.includes(v))) {
          return Object.fromEntries(
            ["low", "medium", "high", "xhigh", "max"].map((effort) => [
              effort,
              { thinking: { type: "adaptive", display: "summarized" }, effort },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(31_999, model.limit.output - 1),
            },
          },
        }

      case "@ai-sdk/amazon-bedrock":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "enabled",
                maxReasoningEffort: effort,
              },
            },
          ]),
        )

      case "@ai-sdk/google-vertex":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
      case "@ai-sdk/google":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
        if (id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          }
        }
        {
          const levels = id.includes("3.1") ? ["low", "medium", "high"] : ["low", "high"]
          return Object.fromEntries(
            levels.map((effort) => [
              effort,
              {
                thinkingConfig: {
                  includeThoughts: true,
                  thinkingLevel: effort,
                },
              },
            ]),
          )
        }

      case "@ai-sdk/mistral":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
        return {}

      case "@ai-sdk/cohere":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
        return {}

      case "@ai-sdk/groq":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
        const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
        return Object.fromEntries(
          groqEffort.map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )

      case "@ai-sdk/perplexity":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
        return {}
    }
    return {}
  }

  export function options(
    model: Provider.Model,
    sessionID: string,
    providerOptions?: Record<string, any>,
  ): Record<string, any> {
    const result: Record<string, any> = {}

    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
      if (model.api.id.includes("gemini-3")) {
        result["reasoning"] = { effort: "high" }
      }
    }

    if (model.providerID === "baseten") {
      result["chat_template_args"] = { enable_thinking: true }
    }

    if (PromptCachePolicy.usesSessionPromptCacheKey(model, providerOptions)) {
      result["promptCacheKey"] = sessionID
    }

    // openai and providers using openai package should set store to false by default
    // to avoid item_reference lookups that fail on proxies/non-OpenAI backends
    if (model.providerID === "openai" || model.providerID === "openai-codex" || model.api.npm === "@ai-sdk/openai") {
      result["store"] = false
    }

    if (model.api.npm === "@ai-sdk/azure") {
      result["store"] = false
    }

    if (model.api.npm === "@ai-sdk/google" || model.api.npm === "@ai-sdk/google-vertex") {
      if (model.capabilities.reasoning) {
        result["thinkingConfig"] = {
          includeThoughts: true,
        }
        if (model.api.id.includes("gemini-3")) {
          result["thinkingConfig"]["thinkingLevel"] = "high"
        }
      }
    }

    if (model.api.id.includes("gpt-5") && !model.api.id.includes("gpt-5-chat")) {
      if (!model.api.id.includes("codex") && !model.api.id.includes("gpt-5-pro")) {
        // Only inject reasoningEffort for providers that support it natively.
        // @ai-sdk/openai-compatible proxies (e.g. LiteLLM) do not support reasoningEffort + tools
        // on /v1/chat/completions and will return a 400 error.
        if (model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/azure") {
          if (model.providerID !== "openai-codex") {
            result["reasoningEffort"] = "medium"
            result["reasoningSummary"] = "auto"
          }
        }
      }

      // Only set textVerbosity for native openai/azure/copilot providers (Responses API feature).
      // @ai-sdk/openai-compatible proxies do not support this parameter.
      if (
        model.api.id.includes("gpt-5.") &&
        !model.api.id.includes("codex") &&
        !model.api.id.includes("-chat") &&
        model.providerID !== "azure" &&
        model.providerID !== "openai-codex" &&
        model.api.npm === "@ai-sdk/openai"
      ) {
        result["textVerbosity"] = "low"
      }
    }
    return result
  }

  export function smallOptions(model: Provider.Model) {
    if (model.providerID === "openai-codex") {
      return { store: false }
    }
    if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") {
      if (model.api.id.includes("gpt-5")) {
        if (model.api.id.includes("5.") || model.api.id.includes("5-mini")) {
          return { store: false, reasoningEffort: "low" }
        }
        return { store: false, reasoningEffort: "minimal" }
      }
      return { store: false }
    }
    if (model.providerID === "google") {
      // gemini-3 uses thinkingLevel, gemini-2.5 uses thinkingBudget
      if (model.api.id.includes("gemini-3")) {
        return { thinkingConfig: { thinkingLevel: "minimal" } }
      }
      return { thinkingConfig: { thinkingBudget: 0 } }
    }
    if (model.providerID === "openrouter") {
      if (model.api.id.includes("google")) {
        return { reasoning: { enabled: false } }
      }
      return { reasoning: { effort: "minimal" } }
    }
    return {}
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    switch (model.api.npm) {
      case "@ai-sdk/openai":
        return {
          ["openai" as string]: options,
        }
      case "@ai-sdk/azure":
        // Azure delegates to OpenAIChatLanguageModel which reads from providerOptions["openai"],
        // but OpenAIResponsesLanguageModel checks "azure" first. Pass both.
        return { openai: options, azure: options }
      case "@ai-sdk/amazon-bedrock":
        return {
          ["bedrock" as string]: options,
        }
      case "@ai-sdk/anthropic":
        return {
          ["anthropic" as string]: options,
        }
      case "@ai-sdk/google-vertex":
      case "@ai-sdk/google":
        return {
          ["google" as string]: options,
        }
      case "@ai-sdk/gateway":
        return {
          ["gateway" as string]: options,
        }
      case "@openrouter/ai-sdk-provider":
        return {
          ["openrouter" as string]: options,
        }
      default:
        return {
          [model.providerID]: options,
        }
    }
  }

  export function maxOutputTokens(
    npm: string,
    options: Record<string, any>,
    modelLimit: number,
    globalLimit: number,
  ): number {
    const modelCap = modelLimit || globalLimit
    const standardLimit = Math.min(modelCap, globalLimit)

    if (npm === "@ai-sdk/anthropic") {
      const thinking = options?.["thinking"]
      const budgetTokens = typeof thinking?.["budgetTokens"] === "number" ? thinking["budgetTokens"] : 0
      const enabled = thinking?.["type"] === "enabled"
      if (enabled && budgetTokens > 0) {
        // Return text tokens so that text + thinking <= model cap, preferring 32k text when possible.
        if (budgetTokens + standardLimit <= modelCap) {
          return standardLimit
        }
        return modelCap - budgetTokens
      }
    }

    return standardLimit
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema, options?: SchemaOptions) {
    /*
    if (["openai", "azure"].includes(providerID)) {
      if (schema.type === "object" && schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (schema.required?.includes(key)) continue
          schema.properties[key] = {
            anyOf: [
              value as JSONSchema.JSONSchema,
              {
                type: "null",
              },
            ],
          }
        }
      }
    }
    */

    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") {
          return obj
        }

        if (Array.isArray(obj)) {
          return obj.map(sanitizeGemini)
        }

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            // Convert all enum values to strings
            result[key] = value.map((v) => String(v))
            // If we have integer type with enum, change type to string
            if (result.type === "integer" || result.type === "number") {
              result.type = "string"
            }
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        // Filter required array to only include fields that exist in properties
        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }

        if (result.type === "array" && result.items == null) {
          result.items = {}
        }

        return result
      }

      schema = sanitizeGemini(schema)
    }

    if (schema.type !== "object") {
      const received = Array.isArray(schema.type) ? schema.type.join("|") : (schema.type ?? "None")
      const label = options?.tool ? `Tool '${options.tool}'` : "Tool input schema"
      throw new Error(
        `${label} is invalid: function/tool parameters must be a top-level JSON Schema object. Received type "${received}". Avoid top-level z.union(...) or z.discriminatedUnion(...); wrap variants inside z.object(...) instead.`,
      )
    }

    return schema
  }

  export function error(providerID: string, error: APICallError) {
    let message = error.message
    if (providerID === "github-copilot" && message.includes("The requested model is not supported")) {
      return (
        message +
        "\n\nMake sure the model is enabled in your copilot settings: https://github.com/settings/copilot/features"
      )
    }

    return message
  }
}
