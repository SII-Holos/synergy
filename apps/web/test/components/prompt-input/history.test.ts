import { expect, test } from "bun:test"
import { InputAssistance } from "@ericsanchezok/synergy-util/input-assistance"
import { sanitizePromptHistory } from "../../../src/components/prompt-input/history"

test("history migration preserves assistance across serialization and accepts old plain prompts", () => {
  const prompt = [{ type: "text", content: "再检查边界", start: 0, end: 5 }]
  const assistance = InputAssistance.accept(undefined, {
    producer: "digital-twin",
    proposalID: "p",
    generated: "再检查边界",
    accepted: "再检查边界",
  })
  const saved = sanitizePromptHistory(JSON.parse(JSON.stringify({ entries: [{ prompt, assistance }, prompt] })))
  expect(saved.entries[0]).toEqual({ prompt, assistance })
  expect(saved.entries[1]).toEqual({ prompt })
  expect(sanitizePromptHistory(saved)).toEqual(saved)
})
