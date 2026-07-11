import { describe, expect, test } from "bun:test"
import type { Part as PartType, UserMessage } from "@ericsanchezok/synergy-sdk/client"

import { getSpecialUserMessageBubbleView } from "./special-user-message-model"

function userMessage(metadata: Record<string, unknown>): UserMessage {
  return {
    id: "message_user",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    metadata,
  } as UserMessage
}

function textPart(text: string): PartType {
  return {
    id: "part_text",
    sessionID: "session",
    messageID: "message_user",
    type: "text",
    text,
  } as PartType
}

function projectedText(view: { parts: PartType[] } | undefined) {
  return view?.parts
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
}

describe("special user messages", () => {
  test("keeps workflow user requests as their original prompt bubbles", () => {
    const message = userMessage({ workflow: "plan" })
    const originalParts = [textPart("Create a Blueprint")]
    const view = getSpecialUserMessageBubbleView(message, originalParts)

    expect(view?.label).toBe("Plan")
    expect(view?.kind).toBe("plan-request")
    expect(view?.parts).toBe(originalParts)
    expect(projectedText(view)).toContain("Create a Blueprint")
  })

  test("projects Blueprint start into a concise user bubble", () => {
    const message = userMessage({
      source: "blueprint_loop_start",
      loopID: "loop_123",
      noteID: "note_123",
      title: "Anima",
      userPrompt: "Implement this directly in the worktree.",
    })
    const view = getSpecialUserMessageBubbleView(message, [
      textPart("Execute the coding Blueprint with a long internal prompt."),
    ])

    expect(view?.label).toBe("Blueprint")
    expect(view?.kind).toBe("blueprint-control")
    expect(projectedText(view)).toContain("Implement this directly in the worktree.")
    expect(projectedText(view)).not.toContain("Execute the coding Blueprint")
    expect(projectedText(view)).not.toContain("loop_123")
    expect(projectedText(view)).not.toContain("note_123")
  })

  test("projects Blueprint controls into concise badged user bubbles", () => {
    const cases = [
      ["blueprint_loop_continuation", "Blueprint · Continue", "Check progress"],
      ["blueprint_loop_rejected", "Blueprint · Changes requested", "Run the suite again"],
      ["blueprint_loop_completed", "Blueprint · Completed", "Shipped the change"],
    ] as const

    for (const [source, label, expected] of cases) {
      const message = userMessage({
        source,
        title: "Anima",
        loopID: "loop_123",
        noteID: "note_123",
        reason: "Tests failed",
        instructions: "Run the suite again",
        summary: "Shipped the change",
      })
      const view = getSpecialUserMessageBubbleView(message, [textPart("Raw internal control prompt")])

      expect(view?.label).toBe(label)
      expect(view?.kind).toBe("blueprint-control")
      expect(projectedText(view)).toContain(expected)
      expect(projectedText(view)).not.toContain("Raw internal control prompt")
      expect(projectedText(view)).not.toContain("loop_123")
      expect(projectedText(view)).not.toContain("note_123")
    }
  })

  test("projects workflow continuation controls into concise user bubbles", () => {
    const cases = [
      ["light_loop_continuation", "Light Loop · Continue", "keep going"],
      ["lattice_continuation", "Lattice · Continue", "Current phase: result_analysis"],
      ["lattice_planning_kick", "Lattice", "Start planning: Ship the project"],
    ] as const

    for (const [source, label, expected] of cases) {
      const message = userMessage({
        source,
        phase: "result_analysis",
        goal: "Ship the project",
      })
      const view = getSpecialUserMessageBubbleView(message, [textPart("Raw workflow control prompt")])

      expect(view?.label).toBe(label)
      expect(projectedText(view)).toContain(expected)
      expect(projectedText(view)).not.toContain("Raw workflow control prompt")
    }
  })
})
