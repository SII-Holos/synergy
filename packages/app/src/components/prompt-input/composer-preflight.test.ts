import { expect, test } from "bun:test"
import { ComposerDocumentController } from "./composer-document"
import { runComposerPreflight } from "./composer-preflight"

function fixture() {
  let text = "hello"
  const controller = new ComposerDocumentController({
    read: () => ({ text, selection: { start: text.length, end: text.length }, mode: "normal" }),
    applyEdits(edits) {
      for (const edit of edits) text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end)
    },
  })
  return {
    controller,
    text: () => text,
    restore: () => {
      text = "hello"
    },
  }
}

test("restores the original draft when a later preflight extension fails", async () => {
  const { controller, text, restore } = fixture()
  controller.register({
    id: "editor",
    order: 1,
    async onBeforeSubmit(snapshot) {
      await controller.applyEdits({
        revision: snapshot.revision,
        edits: [{ range: { start: snapshot.text.length, end: snapshot.text.length }, text: " world" }],
      })
    },
  })
  controller.register({
    id: "broken",
    order: 2,
    async onBeforeSubmit() {
      throw new Error("extension failure")
    },
  })
  const failures: unknown[] = []

  const completed = await runComposerPreflight({
    beforeSubmit: () => controller.beforeSubmit(),
    restore,
    onNonAbortError: (error) => failures.push(error),
  })

  expect(completed).toBe(false)
  expect(text()).toBe("hello")
  expect(failures).toHaveLength(1)
})

test("restores the original draft without reporting a host cancellation", async () => {
  const { controller, text, restore } = fixture()
  let entered!: () => void
  const extensionEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  controller.register({
    id: "editor",
    order: 1,
    async onBeforeSubmit(snapshot) {
      await controller.applyEdits({
        revision: snapshot.revision,
        edits: [{ range: { start: snapshot.text.length, end: snapshot.text.length }, text: " world" }],
      })
    },
  })
  controller.register({
    id: "cancelled",
    order: 2,
    async onBeforeSubmit(_snapshot, context) {
      entered()
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })
      })
    },
  })
  const failures: unknown[] = []

  const pending = runComposerPreflight({
    beforeSubmit: () => controller.beforeSubmit(),
    restore,
    onNonAbortError: (error) => failures.push(error),
  })
  await extensionEntered
  controller.abortSubmit(new DOMException("Composer submit cancelled", "AbortError"))

  expect(await pending).toBe(false)
  expect(text()).toBe("hello")
  expect(failures).toEqual([])
})
