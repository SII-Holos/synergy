import { describe, expect, test } from "bun:test"
import { ComposerDocumentController, type ComposerEdit } from "./composer-document"

function fixture(options?: { settleMs?: number; submitTimeoutMs?: number }) {
  let text = "hello"
  let selection = { start: 5, end: 5 }
  const controller = new ComposerDocumentController(
    {
      read: () => ({ text, selection, mode: "normal" }),
      applyEdits(edits: ComposerEdit[]) {
        for (const edit of edits) text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end)
        const end = edits.at(-1)?.range.start ?? text.length
        selection = { start: end, end }
      },
    },
    { settleMs: options?.settleMs ?? 10, beforeSubmitTimeoutMs: options?.submitTimeoutMs ?? 100 },
  )
  return { controller, text: () => text, selection: (value: { start: number; end: number }) => (selection = value) }
}

describe("ComposerDocumentController", () => {
  test("settles the latest revision and aborts stale draft work", async () => {
    const { controller } = fixture()
    const calls: Array<{ revision: number; signal: AbortSignal }> = []
    controller.register({
      id: "observer",
      onDraftSettled(snapshot, context) {
        calls.push({ revision: snapshot.revision, signal: context.signal })
      },
    })
    await Bun.sleep(15)
    expect(calls.map((call) => call.revision)).toEqual([0])
    controller.changed()
    expect(calls[0]?.signal.aborted).toBe(true)
    controller.changed()
    await Bun.sleep(15)
    expect(calls.map((call) => call.revision)).toEqual([0, 2])
  })

  test("suppresses settled hooks during IME composition", async () => {
    const { controller } = fixture()
    let calls = 0
    controller.register({ id: "ime", onDraftSettled: () => void calls++ })
    controller.setComposing(true)
    controller.changed()
    await Bun.sleep(15)
    expect(calls).toBe(0)
    controller.setComposing(false)
    await Bun.sleep(15)
    expect(calls).toBe(1)
  })

  test("separates completion, decorations, and atomic edits", async () => {
    const { controller, text } = fixture()
    const service = controller.service({
      id: "writer",
      capabilities: new Set(["composer.read", "composer.write"]),
    })
    const snapshot = service.current()
    service.setCompletion({ revision: snapshot.revision, position: 5, text: " world" })
    expect(controller.completion()?.text).toBe(" world")
    service.setDecorations({
      revision: snapshot.revision,
      items: [{ id: "typo", range: { start: 0, end: 5 }, severity: "warning", replacement: "Hello" }],
    })
    expect(controller.decorations()).toHaveLength(1)
    const next = await service.applyEdits({
      revision: snapshot.revision,
      edits: [{ range: { start: 0, end: 5 }, text: "Hello" }],
    })
    expect(text()).toBe("Hello")
    expect(next.revision).toBe(1)
    expect(controller.completion()).toBeUndefined()
    expect(controller.decorations()).toEqual([])
  })

  test("rejects stale, overlapping, and unauthorized writes", async () => {
    const { controller } = fixture()
    const writer = controller.service({ id: "writer", capabilities: new Set(["composer.write"]) })
    await expect(writer.applyEdits({ revision: 1, edits: [] })).rejects.toMatchObject({ code: "stale_revision" })
    await expect(
      writer.applyEdits({
        revision: 0,
        edits: [
          { range: { start: 0, end: 3 }, text: "a" },
          { range: { start: 2, end: 4 }, text: "b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "overlapping_edits" })
    const reader = controller.service({ id: "reader", capabilities: new Set(["composer.read"]) })
    expect(() => reader.setCompletion(undefined)).toThrow("composer.write")
    writer.dispose()
    expect(() => writer.setCompletion(undefined)).toThrow("disposed")
  })

  test("runs submit hooks serially against the latest document and degrades failures", async () => {
    const { controller, text } = fixture()
    const order: string[] = []
    controller.register({
      id: "first",
      order: 1,
      async onBeforeSubmit(snapshot) {
        order.push(`first:${snapshot.text}`)
        await controller.applyEdits({
          revision: snapshot.revision,
          edits: [{ range: { start: 5, end: 5 }, text: "!" }],
        })
      },
    })
    controller.register({
      id: "second",
      order: 2,
      async onBeforeSubmit(snapshot) {
        order.push(`second:${snapshot.text}`)
      },
    })
    await controller.beforeSubmit()
    expect(text()).toBe("hello!")
    expect(order).toEqual(["first:hello", "second:hello!"])

    let attempts = 0
    controller.register({
      id: "broken",
      order: 0,
      async onBeforeSubmit() {
        attempts++
        throw new Error("broken")
      },
    })
    await expect(controller.beforeSubmit()).rejects.toThrow("broken")
    await controller.beforeSubmit()
    expect(attempts).toBe(1)
  })

  test("times out a submit hook that ignores cancellation", async () => {
    const { controller } = fixture({ submitTimeoutMs: 10 })
    controller.register({
      id: "stalled",
      onBeforeSubmit: () => new Promise(() => undefined),
    })
    await expect(controller.beforeSubmit()).rejects.toBeInstanceOf(Error)
    expect(controller.submitting()).toBe(false)
    await controller.beforeSubmit()
  })

  test("does not degrade a submit hook cancelled by its host", async () => {
    const { controller } = fixture()
    let attempts = 0
    controller.register({
      id: "cancelled",
      async onBeforeSubmit(_snapshot, context) {
        attempts++
        if (attempts > 1) return
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })
        })
      },
    })
    const abort = new AbortController()
    const pending = controller.beforeSubmit(abort.signal)
    abort.abort(new DOMException("navigation changed", "AbortError"))
    await expect(pending).rejects.toBeInstanceOf(DOMException)
    await controller.beforeSubmit()
    expect(attempts).toBe(2)
  })
})
