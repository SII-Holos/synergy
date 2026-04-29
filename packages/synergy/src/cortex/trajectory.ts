import type { MessageV2 } from "@/session/message-v2"
import { ToolTaxonomy, type ToolKind } from "@/tool/taxonomy"

export namespace Trajectory {
  interface Step {
    index: number
    textChars: number
    toolCount: number
    toolKinds: ToolKind[]
    toolNames: string[]
    hasError: boolean
    isContent: boolean
    text: string
  }

  interface WorkSegment {
    kind: ToolKind
    start: number
    end: number
    toolCount: number
    stepCount: number
  }

  interface KeyEvent {
    step: number
    type: "pivot" | "discovery" | "setback"
    label: string
    excerpt?: string
  }

  export async function summarize(sessionID: string): Promise<string> {
    const { Session } = await import("@/session")
    const messages = await Session.messages({ sessionID })
    const steps = extractSteps(messages)

    if (steps.length === 0) {
      return "No assistant messages found in subagent session."
    }

    const segments = buildWorkSegments(steps)
    const events = detectEvents(steps, segments)

    return render(steps, segments, events)
  }

  function extractSteps(messages: MessageV2.WithParts[]): Step[] {
    const steps: Step[] = []
    let idx = 0

    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue
      idx++

      let textChars = 0
      let toolCount = 0
      const toolKinds: ToolKind[] = []
      const toolNames: string[] = []
      let hasError = false
      const texts: string[] = []

      for (const part of msg.parts) {
        if (part.type === "text" && !part.synthetic && !part.ignored) {
          textChars += part.text.length
          texts.push(part.text)
        } else if (part.type === "tool") {
          toolCount++
          toolNames.push(part.tool)
          const kind = ToolTaxonomy.classify(part.tool).kind
          toolKinds.push(kind)
          if (part.state.status === "error") hasError = true
        }
      }

      if (textChars === 0 && toolCount === 0) continue

      const isContent = toolCount === 0 ? textChars >= 200 : toolCount <= 1 && textChars >= 400

      steps.push({
        index: idx,
        textChars,
        toolCount,
        toolKinds: [...new Set(toolKinds)],
        toolNames: [...new Set(toolNames)],
        hasError,
        isContent,
        text: texts.join("\n").trim(),
      })
    }

    return steps
  }

  function dominantKind(kinds: ToolKind[], fallback?: ToolKind): ToolKind {
    if (kinds.length === 0) return fallback ?? "code.read"
    const counts = new Map<ToolKind, number>()
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
    let best = kinds[0]
    let bestCount = 0
    for (const [k, c] of counts) {
      if (c > bestCount) {
        best = k
        bestCount = c
      }
    }
    return best
  }

  function buildWorkSegments(steps: Step[]): WorkSegment[] {
    if (steps.length === 0) return []

    const segments: WorkSegment[] = []
    const working = steps.filter((s) => !s.isContent)

    if (working.length === 0) return []

    let current: WorkSegment = {
      kind: dominantKind(working[0].toolKinds),
      start: working[0].index,
      end: working[0].index,
      toolCount: working[0].toolCount,
      stepCount: 1,
    }

    for (let i = 1; i < working.length; i++) {
      const step = working[i]
      const kind = dominantKind(step.toolKinds, current.kind)
      const sameDomain = kind.split(".")[0] === current.kind.split(".")[0]
      const auxiliary = step.toolNames.every((name) => ToolTaxonomy.isAuxiliary(name))
      const gap = step.index - current.end

      if ((sameDomain || auxiliary) && gap <= 3) {
        current.end = step.index
        current.toolCount += step.toolCount
        current.stepCount++
      } else {
        segments.push(current)
        current = {
          kind,
          start: step.index,
          end: step.index,
          toolCount: step.toolCount,
          stepCount: 1,
        }
      }
    }
    segments.push(current)
    return segments
  }

  function detectEvents(steps: Step[], segments: WorkSegment[]): KeyEvent[] {
    const events: KeyEvent[] = []

    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1]
      const curr = segments[i]
      if (prev.kind.split(".")[0] !== curr.kind.split(".")[0]) {
        events.push({
          step: curr.start,
          type: "pivot",
          label: `${ToolTaxonomy.KIND_LABELS[prev.kind]} → ${ToolTaxonomy.KIND_LABELS[curr.kind]}`,
        })
      }
    }

    for (let i = 1; i < steps.length; i++) {
      const step = steps[i]
      const prev = steps[i - 1]
      if (step.isContent && !prev.isContent && step.textChars > 500) {
        events.push({
          step: step.index,
          type: "discovery",
          label: `Content output (${step.textChars.toLocaleString()} chars)`,
          excerpt: step.text.slice(0, 200),
        })
      }
    }

    for (const step of steps) {
      if (step.hasError) {
        events.push({
          step: step.index,
          type: "setback",
          label: "Tool call failed",
        })
      }
    }

    return events.sort((a, b) => a.step - b.step)
  }

  function render(steps: Step[], segments: WorkSegment[], events: KeyEvent[]): string {
    const lines: string[] = []
    const totalTools = steps.reduce((s, t) => s + t.toolCount, 0)

    const phaseChain =
      segments.length > 0
        ? segments
            .map((s) => `${ToolTaxonomy.KIND_LABELS[s.kind]}(${s.stepCount} steps/${s.toolCount} calls)`)
            .join(" → ")
        : "Pure output"

    lines.push("## Execution Trajectory")
    lines.push("")
    lines.push(`**Steps**: ${steps.length} | **Tool calls**: ${totalTools}`)
    lines.push(`**Phases**: ${phaseChain}`)
    lines.push("")

    if (events.length > 0) {
      lines.push("### Key Events")
      lines.push("")
      for (const e of events) {
        const icon = e.type === "pivot" ? "↺" : e.type === "discovery" ? "★" : "⚠"
        lines.push(`${icon} **Step ${e.step}**: ${e.label}`)
        if (e.excerpt) {
          lines.push(`   > ${e.excerpt.replace(/\n/g, " ")}...`)
        }
        lines.push("")
      }
    }

    const contentSteps = steps.filter((s) => s.isContent)
    if (contentSteps.length > 0) {
      lines.push("---")
      lines.push("")
      for (const step of contentSteps) {
        if (step.text.length > 0) {
          lines.push(step.text)
          lines.push("")
        }
      }
    }

    return lines.join("\n")
  }
}
