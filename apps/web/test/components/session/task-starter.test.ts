import { expect, test } from "bun:test"
import { ComposerDocumentController } from "../../../src/components/prompt-input/composer-document"
import { prepareTaskStarter } from "../../../src/components/session/task-starter"

function fixture(initial = "") {
  let text = initial
  const document = new ComposerDocumentController({
    read: () => ({ text, mode: "normal", selection: { start: text.length, end: text.length } }),
    applyEdits: (edits) => {
      for (const edit of edits) text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end)
    },
  })
  const input = { current: () => document.current(), applyEdits: document.applyEdits.bind(document), select: () => {} }
  return { document, input, text: () => text }
}

test("task starters prepare an editable draft without submitting", async () => {
  const f = fixture()
  try {
    const request = prepareTaskStarter(f.input, () => f.input, "Research this question: ")
    expect(request.requiresConfirmation).toBe(false)
    expect(await request.apply()).toBe(true)
    expect(f.text()).toBe("Research this question: ")
  } finally {
    f.document.dispose()
  }
})

test("replacement is deferred and rejects edits made after confirmation opened", async () => {
  const f = fixture("Keep this draft")
  try {
    const request = prepareTaskStarter(f.input, () => f.input, "Replacement")
    expect(request.requiresConfirmation).toBe(true)
    expect(f.text()).toBe("Keep this draft")
    await f.input.applyEdits({
      revision: f.input.current().revision,
      edits: [{ range: { start: 0, end: 0 }, text: "New " }],
    })
    expect(await request.apply()).toBe(false)
    expect(f.text()).toBe("New Keep this draft")
  } finally {
    f.document.dispose()
  }
})

test("a starter cannot replace the draft of another input owner", async () => {
  const f = fixture("Original")
  try {
    const request = prepareTaskStarter(f.input, () => undefined, "Replacement")
    expect(await request.apply()).toBe(false)
    expect(f.text()).toBe("Original")
  } finally {
    f.document.dispose()
  }
})
