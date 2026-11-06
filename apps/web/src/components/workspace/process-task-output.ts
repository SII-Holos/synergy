import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"

export type ProcessTaskOutput = {
  raw: string
  text: string
  language?: "json"
  trajectory?: string
  steps?: number
  toolCalls?: number
}

export function processTaskOutput(output: unknown): ProcessTaskOutput | undefined {
  if (!output || typeof output !== "object") return
  const saved = output as { mode?: unknown; value?: unknown }
  if (saved.mode === "structured" && "value" in saved) {
    const text = JSON.stringify(saved.value, null, 2)
    return text === undefined ? undefined : { raw: text, text, language: "json" }
  }
  if ((saved.mode !== "summary" && saved.mode !== "final_response") || typeof saved.value !== "string") return
  const raw = saved.value
  const header =
    saved.mode === "summary"
      ? /^## Execution Trajectory\r?\n\r?\n\*\*Steps\*\*: (\d+) \| \*\*Tool calls\*\*: (\d+)\r?\n(?:\r?\n)?\*\*Phases\*\*: [^\r\n]+(?:\r?\n|$)/.exec(
          raw,
        )
      : null
  if (!header) return { raw, text: raw }
  const separator = /\r?\n---\r?\n(?:\r?\n)?/.exec(raw.slice(header[0].length))
  const end = separator ? header[0].length + separator.index : raw.length
  return {
    raw,
    text: separator ? raw.slice(end + separator[0].length) : "",
    trajectory: raw.slice(0, end).trimEnd(),
    steps: Number(header[1]),
    toolCalls: Number(header[2]),
  }
}

export function toolTaskOutput(part: ToolPart) {
  if (part.tool !== "task_output" || part.state.status !== "completed") return
  const { input, metadata } = part.state
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  if (!metadata || metadata.found !== true || typeof input.taskId !== "string" || metadata.taskId !== input.taskId)
    return
  if ((input.mode ?? "full") !== "full" || (metadata.mode ?? "full") !== "full") return
  const report = processTaskOutput(metadata.output)
  return report ? { report, status: metadata.status } : undefined
}
