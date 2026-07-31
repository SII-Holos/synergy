import { expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { inlineCompletionPrefix, inlineText } from "../../../src/components/prompt-input/content"

test("includes visible file pills before an inline completion", () => {
  const prompt: Prompt = [
    { type: "text", content: "Fix ", start: 0, end: 4 },
    { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 4, end: 15 },
    { type: "text", content: " now", start: 15, end: 19 },
  ]

  expect(inlineCompletionPrefix(prompt, 15)).toBe("Fix @src/app.ts")
  expect(inlineCompletionPrefix(prompt, 19)).toBe("Fix @src/app.ts now")
})

test("keeps file pill content in the submitted text coordinate space", () => {
  const prompt: Prompt = [
    { type: "text", content: "Read ", start: 0, end: 5 },
    { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 5, end: 16 },
    { type: "text", content: " now", start: 16, end: 20 },
  ]

  expect(inlineText(prompt)).toBe("Read @src/app.ts now")
})
