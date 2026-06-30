import Ajv2020 from "ajv/dist/2020"
import type { JSONSchema7 } from "ai"
import { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"
import type { ToolResolver } from "@/session/tool-resolver"
import type { CortexTypes } from "./types"

export namespace CortexOutput {
  export const STRUCTURED_TOOL_ID = "structured_task_result"
  const DEFAULT_MAX_REPAIR_TURNS = 3

  type StructuredConfig = Extract<CortexTypes.OutputConfig, { mode: "structured" }>

  type ValidationResult =
    | {
        valid: true
        data: unknown
      }
    | {
        valid: false
        errors: string[]
      }

  export function normalize(output?: CortexTypes.OutputConfig): CortexTypes.OutputConfig {
    return output ?? { mode: "summary" }
  }

  export function maxRepairTurns(output: StructuredConfig) {
    return output.maxRepairTurns ?? DEFAULT_MAX_REPAIR_TURNS
  }

  export function toolsFor(base: Record<string, boolean> | undefined, output: CortexTypes.OutputConfig) {
    if (output.mode !== "structured") return base
    return {
      ...(base ?? {}),
      [STRUCTURED_TOOL_ID]: true,
    }
  }

  export function ephemeralTools(output: CortexTypes.OutputConfig): ToolResolver.EphemeralTool[] | undefined {
    if (output.mode !== "structured") return undefined
    return [
      {
        id: STRUCTURED_TOOL_ID,
        description: "Submit the structured result for this delegated task. Use this exactly once when finished.",
        inputSchema: output.schema as JSONSchema7,
        async execute(args) {
          return {
            title: "Structured task result",
            output: JSON.stringify(args),
            metadata: {
              hidden: true,
              structured: true,
            },
          }
        },
      },
    ]
  }

  export function initialPrompt(prompt: string, output: CortexTypes.OutputConfig) {
    if (output.mode !== "structured") return prompt
    return [
      prompt,
      "",
      "<cortex-output>",
      "This delegated task requires a structured final result.",
      `You must submit the result by calling the ${STRUCTURED_TOOL_ID} tool with arguments that match this JSON Schema.`,
      "If tool calling is unavailable, your final assistant response must be only a JSON value matching the same schema.",
      "Do not wrap the JSON in Markdown.",
      JSON.stringify(output.schema),
      "</cortex-output>",
    ].join("\n")
  }

  export function repairPrompt(output: StructuredConfig, result: CortexTypes.OutputResult, attempt: number) {
    const errors = result.mode === "structured" ? (result.validationErrors ?? [result.error ?? "Unknown error"]) : []
    return [
      "<cortex-output-repair>",
      `The previous response did not satisfy the required structured output schema. Repair attempt ${attempt} of ${maxRepairTurns(output)}.`,
      "Call the structured_task_result tool with valid arguments. If tool calling is unavailable, reply with only valid JSON.",
      "Validation errors:",
      ...errors.map((error) => `- ${error}`),
      "Required JSON Schema:",
      JSON.stringify(output.schema),
      "</cortex-output-repair>",
    ].join("\n")
  }

  export async function resolve(
    sessionID: string,
    output: CortexTypes.OutputConfig,
    repairTurns: number,
  ): Promise<CortexTypes.OutputResult | undefined> {
    if (output.mode === "summary" || output.mode === undefined) return undefined
    const messages = await Session.messages({ sessionID })
    const text = finalAssistantText(messages)
    if (output.mode === "final_response") {
      return {
        mode: "final_response",
        text,
      }
    }
    if (output.mode !== "structured") return undefined

    const validationErrors: string[] = []
    const toolInput = lastStructuredToolInput(messages)
    if (toolInput !== undefined) {
      const validation = validate(output.schema, toolInput)
      if (validation.valid) {
        return {
          mode: "structured",
          status: "valid",
          source: "structured_tool",
          data: validation.data,
          text,
          repairTurns,
        }
      }
      validationErrors.push(...validation.errors.map((error) => `structured_task_result: ${error}`))
    }

    const parsed = parseJson(text)
    if (parsed.ok) {
      const validation = validate(output.schema, parsed.value)
      if (validation.valid) {
        return {
          mode: "structured",
          status: "valid",
          source: "final_response",
          data: validation.data,
          text,
          repairTurns,
        }
      }
      validationErrors.push(...validation.errors.map((error) => `final_response: ${error}`))
    } else if (text.trim()) {
      validationErrors.push(`final_response: ${parsed.error}`)
    }

    return {
      mode: "structured",
      status: "invalid",
      text,
      repairTurns,
      error: validationErrors[0] ?? "No structured task result was produced",
      validationErrors: validationErrors.length > 0 ? validationErrors : ["No structured task result was produced"],
    }
  }

  function validate(schema: Record<string, any>, value: unknown): ValidationResult {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    let validate: ReturnType<typeof ajv.compile>
    try {
      validate = ajv.compile(schema)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { valid: false, errors: [`schema: ${message}`] }
    }
    if (validate(value)) {
      return { valid: true, data: value }
    }
    return {
      valid: false,
      errors: (validate.errors ?? []).map((error: NonNullable<typeof validate.errors>[number]) => {
        const path = error.instancePath || "/"
        return `${path} ${error.message ?? "is invalid"}`.trim()
      }),
    }
  }

  function lastStructuredToolInput(messages: MessageV2.WithParts[]) {
    for (const message of [...messages].reverse()) {
      if (message.info.role !== "assistant") continue
      for (const part of [...message.parts].reverse()) {
        if (part.type !== "tool") continue
        if (part.tool !== STRUCTURED_TOOL_ID) continue
        if (part.state.status !== "completed") continue
        return part.state.input
      }
    }
    return undefined
  }

  function finalAssistantText(messages: MessageV2.WithParts[]) {
    for (const message of [...messages].reverse()) {
      if (message.info.role !== "assistant") continue
      const text = message.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
        .join("\n")
        .trim()
      if (text) return text
    }
    return ""
  }

  function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const trimmed = stripMarkdownFence(text.trim())
    if (!trimmed) return { ok: false, error: "No final response text was available" }
    try {
      return { ok: true, value: JSON.parse(trimmed) }
    } catch {}
    const match = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (!match) return { ok: false, error: "Final response did not contain JSON" }
    try {
      return { ok: true, value: JSON.parse(match[0]) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  function stripMarkdownFence(text: string) {
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    return fence ? fence[1].trim() : text
  }
}
