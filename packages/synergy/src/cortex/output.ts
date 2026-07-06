import Ajv2020 from "ajv/dist/2020"
import type { JSONSchema7 } from "ai"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import type { ToolResolver } from "@/session/tool-resolver"
import type { CortexTypes } from "./types"

export namespace CortexOutput {
  export const STRUCTURED_TOOL_ID = "structured_task_result"
  const DEFAULT_MAX_REPAIR_TURNS = 3

  type StructuredConfig = Extract<CortexTypes.OutputConfig, { mode: "structured" }>

  export type Resolution =
    | {
        ok: true
        output: CortexTypes.TaskOutput
      }
    | {
        ok: false
        error: string
        validationErrors: string[]
      }

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

  export function repairTools() {
    return { "*": false, [STRUCTURED_TOOL_ID]: true }
  }

  export function transportSchema(schema: CortexTypes.JsonSchemaObject): JSONSchema7 {
    return {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: {
        value: schema as JSONSchema7,
      },
    }
  }

  export function assertValidStructuredSchema(output: CortexTypes.OutputConfig): void {
    if (output.mode !== "structured") return
    compile(output.schema)
  }

  export function ephemeralTools(output: CortexTypes.OutputConfig): ToolResolver.EphemeralTool[] | undefined {
    if (output.mode !== "structured") return undefined
    return [
      {
        id: STRUCTURED_TOOL_ID,
        description: "Submit the structured result for this delegated task. Use this exactly once when finished.",
        inputSchema: transportSchema(output.schema),
        async execute(args) {
          const value = (args as Record<string, unknown>).value
          return {
            title: "Structured task result",
            output: stringify(value),
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
      `You must submit the result by calling the ${STRUCTURED_TOOL_ID} tool exactly once when finished.`,
      "The tool arguments must be an object with one field named value. Put the final result in value.",
      "The value must match this JSON Schema:",
      stringify(output.schema),
      "If tool calling is unavailable, your final assistant response must be only a JSON value matching the same schema.",
      "Do not wrap the JSON in Markdown.",
      "</cortex-output>",
    ].join("\n")
  }

  export function repairPrompt(output: StructuredConfig, result: Resolution, attempt: number) {
    const errors = result.ok ? [] : result.validationErrors
    return [
      "<cortex-output-repair>",
      `The previous response did not satisfy the required structured output schema. Repair attempt ${attempt} of ${maxRepairTurns(output)}.`,
      "Do not continue task execution. Only repair and resubmit the structured result.",
      `Call ${STRUCTURED_TOOL_ID} with arguments { "value": <result> }. If tool calling is unavailable, reply with only valid JSON.`,
      "Validation errors:",
      ...errors.map((error) => `- ${error}`),
      "Required JSON Schema for value:",
      stringify(output.schema),
      "</cortex-output-repair>",
    ].join("\n")
  }

  export async function resolve(input: {
    sessionID: string
    output: CortexTypes.OutputConfig
    rootMessageID: string
  }): Promise<Resolution | undefined> {
    if (input.output.mode === "summary" || input.output.mode === undefined) return undefined
    const messages = await Session.messages({ sessionID: input.sessionID })
    const scoped = messagesForRoot(messages, input.rootMessageID)
    const text = finalAssistantText(scoped)
    if (input.output.mode === "final_response") {
      return {
        ok: true,
        output: {
          mode: "final_response",
          value: text,
        },
      }
    }
    if (input.output.mode !== "structured") return undefined

    const validationErrors: string[] = []
    const toolInput = lastStructuredToolInput(scoped)
    if (toolInput !== undefined) {
      const extracted = extractTransportValue(toolInput)
      if (extracted.ok) {
        const validation = validate(input.output.schema, extracted.value)
        if (validation.valid) {
          return {
            ok: true,
            output: {
              mode: "structured",
              value: validation.data,
            },
          }
        }
        validationErrors.push(...validation.errors.map((error) => `structured_task_result.value: ${error}`))
      } else {
        validationErrors.push(`structured_task_result: ${extracted.error}`)
      }
    }

    const parsed = parseJson(text)
    if (parsed.ok) {
      const validation = validate(input.output.schema, parsed.value)
      if (validation.valid) {
        return {
          ok: true,
          output: {
            mode: "structured",
            value: validation.data,
          },
        }
      }
      validationErrors.push(...validation.errors.map((error) => `final_response: ${error}`))
    } else if (text.trim()) {
      validationErrors.push(`final_response: ${parsed.error}`)
    }

    const errors = validationErrors.length > 0 ? validationErrors : ["No structured task result was produced"]
    return {
      ok: false,
      error: errors[0],
      validationErrors: errors,
    }
  }

  export function renderTaskOutput(output?: CortexTypes.TaskOutput): string {
    if (!output) return "No output captured"
    if (output.mode === "summary" || output.mode === "final_response") return output.value
    return ["Structured output:", stringify(output.value)].join("\n")
  }

  export function renderTaskOutputForDag(output?: CortexTypes.TaskOutput): string {
    return renderTaskOutput(output)
  }

  export function renderTaskOutputView(task: CortexTypes.Task): {
    taskID: string
    status: CortexTypes.TaskStatus
    rendered: string
    output?: CortexTypes.TaskOutput
    error?: string
  } {
    return {
      taskID: task.id,
      status: task.status,
      rendered: task.status === "error" ? (task.error ?? "Unknown error") : renderTaskOutput(task.output),
      output: task.output,
      error: task.error,
    }
  }

  export function stringify(value: unknown) {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? String(value) : text
  }

  function compile(schema: CortexTypes.JsonSchemaObject) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    try {
      return ajv.compile(schema)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Structured output schema is not valid JSON Schema: ${message}`)
    }
  }

  function validate(schema: CortexTypes.JsonSchemaObject, value: unknown): ValidationResult {
    const validator = compile(schema)
    if (validator(value)) {
      return { valid: true, data: value }
    }
    return {
      valid: false,
      errors: (validator.errors ?? []).map((error: NonNullable<typeof validator.errors>[number]) => {
        const path = error.instancePath || "/"
        return `${path} ${error.message ?? "is invalid"}`.trim()
      }),
    }
  }

  function extractTransportValue(value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Tool input must be an object with a value field" }
    }
    if (!("value" in value)) return { ok: false, error: "Tool input is missing required value field" }
    return { ok: true, value: (value as Record<string, unknown>).value }
  }

  function messagesForRoot(messages: MessageV2.WithParts[], rootMessageID: string) {
    return messages.filter((message) => {
      if (message.info.id === rootMessageID) return true
      if (message.info.rootID === rootMessageID) return true
      if (message.info.role === "assistant" && message.info.parentID === rootMessageID) return true
      return false
    })
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
        .flatMap((part) => (part.type === "text" && !MessageV2.isSystemPart(part) ? [part.text] : []))
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
