import { describe, expect, test } from "bun:test"
import { setupI18n as coreSetupI18n } from "@lingui/core"
import type { Part as PartType } from "@ericsanchezok/synergy-sdk/client"
import {
  computeStatusFromPart,
  computeWorkingPhrase,
  computeLatestStatusFromParts,
  pickStatusPhrase,
  PHRASE_DEFAULTS,
} from "../src/components/session-status"

function reasoningPart(text: string): PartType {
  return {
    id: "r1",
    sessionID: "s",
    messageID: "m",
    type: "reasoning",
    text,
  } as PartType
}

function toolPart(tool: string, status = "running"): PartType {
  return {
    id: "t1",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: "call-1",
    tool,
    state: { status, input: {}, metadata: {} },
  } as PartType
}

function textPart(): PartType {
  return { id: "tx", sessionID: "s", messageID: "m", type: "text", text: "hello" } as PartType
}

function createI18n(messages: Record<string, string> = {}) {
  const i18n = coreSetupI18n({ locale: "en", locales: ["en", "zh-CN"], messages: {} })
  i18n.loadAndActivate({ locale: "en", messages })
  return i18n
}

describe("session-status i18n", () => {
  test("computeStatusFromPart translates reasoning status with label", () => {
    const i18n = createI18n({
      "session-status.thinking-label": "Thinking · {label}",
    })
    const part = reasoningPart("**Plan** the architecture")
    expect(computeStatusFromPart(part, i18n)).toBe("Thinking · Plan")
  })

  test("computeStatusFromPart translates bare reasoning", () => {
    const i18n = createI18n({
      "session-status.thinking": "Thinking",
    })
    const part = reasoningPart("no bold here")
    expect(computeStatusFromPart(part, i18n)).toBe("Thinking")
  })

  test("computeStatusFromPart translates text status", () => {
    const i18n = createI18n({
      "session-status.gathering-thoughts": "Gathering thoughts",
    })
    expect(computeStatusFromPart(textPart(), i18n)).toBe("Gathering thoughts")
  })

  test("computeStatusFromPart translates generating tool status", () => {
    const i18n = createI18n({
      "session-status.generating-input": "ZZZ Generating input",
      "session-status.composing-edits": "ZZZ Composing edits",
    })
    expect(computeStatusFromPart(toolPart("read", "generating"), i18n)).toBe("ZZZ Generating input")
    expect(computeStatusFromPart(toolPart("edit", "generating"), i18n)).toBe("ZZZ Composing edits")
  })

  test("computeStatusFromPart translates running tool status", () => {
    const i18n = createI18n({
      "session-status.delegating-work": "ZZZ Delegating work",
      "session-status.gathering-context": "ZZZ Gathering context",
      "session-status.searching-codebase": "ZZZ Searching the codebase",
      "session-status.searching-web": "ZZZ Searching the web",
      "session-status.making-edits": "ZZZ Making edits",
      "session-status.running-commands": "ZZZ Running commands",
      "session-status.analyzing-files": "ZZZ Analyzing files",
      "session-status.managing-tasks": "ZZZ Managing tasks",
      "session-status.sending-email": "ZZZ Sending email",
    })
    expect(computeStatusFromPart(toolPart("task"), i18n)).toBe("ZZZ Delegating work")
    expect(computeStatusFromPart(toolPart("read"), i18n)).toBe("ZZZ Gathering context")
    expect(computeStatusFromPart(toolPart("glob"), i18n)).toBe("ZZZ Searching the codebase")
    expect(computeStatusFromPart(toolPart("webfetch"), i18n)).toBe("ZZZ Searching the web")
    expect(computeStatusFromPart(toolPart("edit"), i18n)).toBe("ZZZ Making edits")
    expect(computeStatusFromPart(toolPart("bash"), i18n)).toBe("ZZZ Running commands")
    expect(computeStatusFromPart(toolPart("look_at"), i18n)).toBe("ZZZ Analyzing files")
    expect(computeStatusFromPart(toolPart("task_output"), i18n)).toBe("ZZZ Managing tasks")
    expect(computeStatusFromPart(toolPart("email_send"), i18n)).toBe("ZZZ Sending email")
  })

  test("computeStatusFromPart returns undefined for unknown tool", () => {
    const i18n = createI18n({})
    expect(computeStatusFromPart(toolPart("unknown_tool_xyz"), i18n)).toBeUndefined()
  })

  test("computeStatusFromPart returns undefined for undefined part", () => {
    const i18n = createI18n({})
    expect(computeStatusFromPart(undefined, i18n)).toBeUndefined()
  })

  test("computeStatusFromPart defaults to English when no i18n", () => {
    expect(computeStatusFromPart(toolPart("read"), undefined)).toBe("Gathering context")
    expect(computeStatusFromPart(toolPart("edit", "generating"), undefined)).toBe("Composing edits")
    expect(computeStatusFromPart(textPart(), undefined)).toBe("Gathering thoughts")
  })

  test("computeWorkingPhrase resolves i18n waiting phrase messages", () => {
    // Seed "d" (charCode 100) → 100 % 5 = 0 → hits waiting index 0
    const i18n = createI18n({
      "session-status.phrase.waiting.0": "OVERRIDE waiting",
    })
    const phrase = computeWorkingPhrase({ agentName: "X", cortexRunning: 1, seed: "d" }, i18n)
    expect(phrase).toBe("OVERRIDE waiting")
  })

  test("computeWorkingPhrase resolves i18n thinking phrase messages", () => {
    // Seed "f" (charCode 102) → 102 % 6 = 0 → hits thinking index 0
    const i18n = createI18n({
      "session-status.phrase.thinking.0": "OVERRIDE thinking",
    })
    const phrase = computeWorkingPhrase({ agentName: "X", cortexRunning: 0, seed: "f" }, i18n)
    expect(phrase).toBe("OVERRIDE thinking")
  })

  test("PHRASE_DEFAULTS contains expected catalog entries", () => {
    expect(PHRASE_DEFAULTS["session-status.phrase.waiting.0"]).toContain("{agentName}")
    expect(PHRASE_DEFAULTS["session-status.phrase.waiting.0"]).toContain("{count, plural")
    expect(PHRASE_DEFAULTS["session-status.phrase.thinking.0"]).toContain("{agentName}")
    expect(Object.keys(PHRASE_DEFAULTS)).toHaveLength(11)
  })

  test("pickStatusPhrase is deterministic across same seed", () => {
    const ids = ["a", "b", "c"] as const
    expect(pickStatusPhrase(ids, "abc")).toBe(pickStatusPhrase(ids, "abc"))
  })

  test("computeLatestStatusFromParts picks last non-undefined status", () => {
    const i18n = createI18n({
      "session-status.gathering-thoughts": "Gathering thoughts",
      "session-status.thinking-label": "Thinking · {label}",
    })
    const parts: PartType[] = [textPart(), reasoningPart("**Test** hello")]
    expect(computeLatestStatusFromParts(parts, i18n)).toBe("Thinking · Test")
  })

  test("computeLatestStatusFromParts returns undefined when no status found", () => {
    const i18n = createI18n({})
    const parts: PartType[] = [toolPart("unknown_tool")]
    expect(computeLatestStatusFromParts(parts, i18n)).toBeUndefined()
  })
})
