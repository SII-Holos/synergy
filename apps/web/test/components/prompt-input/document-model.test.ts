import { expect, test } from "bun:test"
import { ComposerDocumentController } from "../../../src/components/prompt-input/composer-document"
import { applyPromptDocumentEdits, promptDocumentMapping } from "../../../src/components/prompt-input/document-model"
import type { Prompt } from "../../../src/context/prompt"

test("edits text without a mounted editor while preserving files, attachments and coordinates", async () => {
  const attachment = {
    type: "attachment" as const,
    id: "image",
    filename: "image.png",
    mime: "image/png",
    url: "asset://image",
  }
  let prompt: Prompt = [
    { type: "text", content: "Read ", start: 0, end: 5 },
    { type: "file", path: "a.ts", content: "@a.ts", start: 5, end: 10 },
    { type: "text", content: " now", start: 10, end: 14 },
    attachment,
  ]
  const controller = new ComposerDocumentController({
    read: () => ({
      text: prompt
        .filter((p) => p.type === "text")
        .map((p) => p.content)
        .join(""),
      selection: { start: 0, end: 0 },
      mode: "normal",
    }),
    applyEdits: (edits) => {
      prompt = applyPromptDocumentEdits(prompt, edits)
    },
    isEditableRange: (range) =>
      promptDocumentMapping(prompt).segments.some(
        (part) => range.start >= part.text.start && range.end <= part.text.end,
      ),
  })
  try {
    const original = controller.current()
    await expect(
      controller.applyEdits({
        revision: original.revision,
        edits: [{ range: { start: 3, end: 7 }, text: "crossing" }],
      }),
    ).rejects.toThrow("not editable")
    expect(controller.current()).toEqual(original)
    const result = await controller.applyEdits({
      revision: original.revision,
      edits: [
        { range: { start: 0, end: 4 }, text: "Inspect" },
        { range: { start: 6, end: 9 }, text: "later" },
      ],
    })
    expect(result.text).toBe("Inspect  later")
    expect(prompt.slice(0, 3)).toEqual([
      { type: "text", content: "Inspect ", start: 0, end: 8 },
      { type: "file", path: "a.ts", content: "@a.ts", start: 8, end: 13 },
      { type: "text", content: " later", start: 13, end: 19 },
    ])
    expect(prompt[3]).toBe(attachment)
    await expect(
      controller.applyEdits({ revision: original.revision, edits: [{ range: { start: 0, end: 1 }, text: "X" }] }),
    ).rejects.toThrow("changed")
  } finally {
    controller.dispose()
  }
})

test("invalid edit batches leave the input untouched and empty drafts accept insertion", () => {
  const prompt: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
  expect(() =>
    applyPromptDocumentEdits(prompt, [
      { range: { start: 0, end: 1 }, text: "H" },
      { range: { start: 7, end: 9 }, text: "invalid" },
    ]),
  ).toThrow()
  expect(prompt[0]).toEqual({ type: "text", content: "hello", start: 0, end: 5 })
  expect(
    applyPromptDocumentEdits(
      [{ type: "text", content: "", start: 0, end: 0 }],
      [{ range: { start: 0, end: 0 }, text: "你好" }],
    ),
  ).toEqual([{ type: "text", content: "你好", start: 0, end: 2 }])
})
