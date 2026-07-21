import { describe, expect, test } from "bun:test"
import { TextSelectionController } from "./text-selection"

describe("TextSelectionController", () => {
  test("settles only the latest non-empty selection", async () => {
    const controller = new TextSelectionController({ settleMs: 10 })
    const values: Array<string | undefined> = []
    controller.onSettled((snapshot) => values.push(snapshot?.text))
    controller.update("first")
    controller.update(" second ")
    await Bun.sleep(15)
    expect(controller.current()).toEqual({ text: " second " })
    controller.update("  ")
    await Bun.sleep(15)
    expect(values).toEqual([" second ", undefined])
  })

  test("excludes sensitive and oversized text without truncation", async () => {
    const controller = new TextSelectionController({ settleMs: 1, maxChars: 4 })
    controller.update("secret", { excluded: true })
    await Bun.sleep(5)
    expect(controller.current()).toBeUndefined()
    controller.update("12345")
    await Bun.sleep(5)
    expect(controller.current()).toBeUndefined()
    expect(controller.tooLarge()).toBe(true)
  })

  test("orders namespaced actions and invokes with the exact snapshot", async () => {
    const controller = new TextSelectionController({ settleMs: 1 })
    const received: string[] = []
    controller.registerAction({
      id: "plugin:b",
      label: "B",
      order: 2,
      run: async ({ text }) => void received.push(text),
    })
    controller.registerAction({ id: "plugin:a", label: "A", order: 1, run: async () => undefined })
    expect(controller.actions().map((item) => item.id)).toEqual(["plugin:a", "plugin:b"])
    controller.update("exact")
    await Bun.sleep(5)
    await controller.run("plugin:b", new AbortController().signal)
    expect(received).toEqual(["exact"])
    expect(() =>
      controller.registerAction({ id: "plugin:a", label: "duplicate", order: 0, run: async () => undefined }),
    ).toThrow("already registered")
  })
})
