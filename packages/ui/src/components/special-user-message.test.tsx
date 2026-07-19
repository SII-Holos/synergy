import { describe, expect, test } from "bun:test"
import type { Part as PartType, TextPart, UserMessage } from "@ericsanchezok/synergy-sdk/client"

import { getSpecialUserMessageBubbleView } from "./special-user-message-model"
import { visibleUserMessageText } from "./user-message-utils"

function userMessage(metadata: Record<string, unknown>): UserMessage {
  return {
    id: "message_user",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    metadata,
  } as UserMessage
}

function textPart(text: string): TextPart {
  return {
    id: "part_text",
    sessionID: "session",
    messageID: "message_user",
    type: "text",
    text,
  }
}

function systemTextPart(text: string): TextPart {
  return {
    ...textPart(text),
    origin: "system",
  }
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

    expect(view?.label.id).toBe("special-user.label.plan")
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

    expect(view?.label.id).toBe("special-user.label.blueprint")
    expect(view?.kind).toBe("blueprint-control")
    expect(projectedText(view)).toContain("Implement this directly in the worktree.")
    expect(projectedText(view)).not.toContain("Execute the coding Blueprint")
    expect(projectedText(view)).not.toContain("loop_123")
    expect(projectedText(view)).not.toContain("note_123")
  })

  test("projects Blueprint controls into concise badged user bubbles", () => {
    const cases = [
      ["blueprint_loop_continuation", "special-user.label.blueprint-continue", "Check progress"],
      ["blueprint_loop_rejected", "special-user.label.blueprint-changes", "Run the suite again"],
      ["blueprint_loop_completed", "special-user.label.blueprint-completed", "Shipped the change"],
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

      expect(view?.label.id).toBe(label)
      expect(view?.kind).toBe("blueprint-control")
      expect(projectedText(view)).toContain(expected)
      expect(projectedText(view)).not.toContain("Raw internal control prompt")
      expect(projectedText(view)).not.toContain("loop_123")
      expect(projectedText(view)).not.toContain("note_123")
    }
  })

  test("projects workflow continuation controls into concise user bubbles", () => {
    const cases = [
      ["light_loop_continuation", "special-user.label.lightloop-continue", "keep going"],
      ["lattice_continuation", "special-user.label.lattice-continue", "Current phase: result_analysis"],
      ["lattice_planning_kick", "special-user.label.lattice", "Start planning: Ship the project"],
    ] as const

    for (const [source, label, expected] of cases) {
      const message = userMessage({
        source,
        phase: "result_analysis",
        goal: "Ship the project",
      })
      const view = getSpecialUserMessageBubbleView(message, [textPart("Raw workflow control prompt")])

      expect(view?.label.id).toBe(label)
      expect(projectedText(view)).toContain(expected)
      expect(projectedText(view)).not.toContain("Raw workflow control prompt")
    }
  })
  test("renders Light Loop review verdicts as badged user bubbles without losing feedback", () => {
    const cases = [
      [
        "light_loop_approved",
        "special-user.label.light-loop",
        "special-user.status.approved",
        "success",
        "Light Loop review approved.\n\nAll requested work is complete and verified.",
      ],
      [
        "light_loop_rejected",
        "special-user.label.light-loop",
        "special-user.status.changes-requested",
        "warning",
        "Light Loop review requested changes.\n\n**Reason:** Tests failed\n\n**Remaining:**\nBLOCKING: Fix the regression\n\n**Instructions:**\nRun the suite again",
      ],
    ] as const

    for (const [source, sourceLabel, statusLabel, tone, feedback] of cases) {
      const originalParts = [systemTextPart(feedback)]
      const view = getSpecialUserMessageBubbleView(userMessage({ source }), originalParts)

      expect(view?.label.id).toBe(sourceLabel)
      expect(view?.status?.label.id).toBe(statusLabel)
      expect(view?.status?.tone).toBe(tone)
      expect(view?.kind).toBe("lightloop-control")
      expect(originalParts[0]?.origin).toBe("system")
      expect(view?.parts.find((part) => part.type === "text")?.origin).toBe("user")
      expect(projectedText(view)).toBe(feedback)
      expect(visibleUserMessageText(view?.parts)).toBe(feedback)
    }
  })
})
