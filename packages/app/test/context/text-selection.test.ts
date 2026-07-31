import { describe, expect, test } from "bun:test"
import { TextSelectionController, groupTextActions, type TextSelectionSnapshot } from "../../src/context/text-selection"

const snapshot = (text: string): Omit<TextSelectionSnapshot, "selectionId"> => ({
  text,
  source: "document",
  origin: "other",
  editable: false,
  wholeContainer: false,
})

describe("TextSelectionController", () => {
  test("settles only the latest non-empty selection", async () => {
    const controller = new TextSelectionController({ settleMs: 10 })
    const values: Array<string | undefined> = []
    controller.onSettled((snapshot) => values.push(snapshot?.text))
    controller.update("first", snapshot("first"))
    controller.update(" second ", snapshot(" second "))
    await Bun.sleep(15)
    expect(controller.current()).toMatchObject(snapshot(" second "))
    expect(controller.current()?.selectionId).toBeString()
    controller.update("  ")
    await Bun.sleep(15)
    expect(values).toEqual([" second ", undefined])
  })

  test("exposes the latest selection immediately while notifications settle", async () => {
    const controller = new TextSelectionController({ settleMs: 10 })
    const values: Array<string | undefined> = []
    controller.onSettled((snapshot) => values.push(snapshot?.text))

    controller.update("latest", snapshot("latest"))

    expect(controller.current()).toMatchObject(snapshot("latest"))
    expect(values).toEqual([])
    await Bun.sleep(15)
    expect(values).toEqual(["latest"])
  })

  test("excludes sensitive and oversized text without truncation", async () => {
    const controller = new TextSelectionController({ settleMs: 1, maxChars: 4 })
    controller.update("secret", { ...snapshot("secret"), excluded: true })
    await Bun.sleep(5)
    expect(controller.current()).toBeUndefined()
    controller.update("12345", snapshot("12345"))
    await Bun.sleep(5)
    expect(controller.current()).toBeUndefined()
    expect(controller.tooLarge()).toBe(true)
  })

  test("keeps oversized ownership scoped to the originating surface", () => {
    const controller = new TextSelectionController({ maxChars: 4 })
    const owner = document.createElement("div")
    const child = document.createElement("span")
    const unrelated = document.createElement("div")
    owner.append(child)
    controller.update("12345", { ...snapshot("12345"), owner })
    expect(controller.current()).toBeUndefined()
    expect(controller.owns(child)).toBe(true)
    expect(controller.owns(unrelated)).toBe(false)
  })

  test("orders namespaced actions and invokes with the exact snapshot", async () => {
    const controller = new TextSelectionController({ settleMs: 1 })
    const received: string[] = []
    const unregister = controller.registerAction({
      id: "plugin:b",
      pluginId: "plugin",
      pluginName: "Plugin",
      label: "B",
      order: 2,
      run: async ({ selection }) => void received.push(selection.text),
    })
    controller.registerAction({
      id: "plugin:a",
      pluginId: "plugin",
      pluginName: "Plugin",
      label: "A",
      order: 1,
      run: async () => undefined,
    })
    expect(controller.actions().map((item) => item.id)).toEqual(["plugin:a", "plugin:b"])
    controller.update("exact", snapshot("exact"))
    await Bun.sleep(5)
    await controller.run("plugin:b", controller.current()!, new AbortController().signal)
    expect(received).toEqual(["exact"])
    expect(() =>
      controller.registerAction({
        id: "plugin:a",
        pluginId: "plugin",
        pluginName: "Plugin",
        label: "duplicate",
        order: 0,
        run: async () => undefined,
      }),
    ).toThrow("already registered")
    expect(controller.hasAction("plugin:a")).toBe(true)
    unregister()
    expect(controller.hasAction("plugin:a")).toBe(true)
    expect(controller.hasAction("plugin:b")).toBe(false)
  })

  test("filters actions against the immutable selection snapshot", () => {
    const controller = new TextSelectionController()
    controller.registerAction({
      id: "translate",
      pluginId: "vibe-lingo",
      pluginName: "VibeLingo",
      label: "Translate",
      order: 1,
      when: {
        sources: ["document"],
        origins: ["assistant_message"],
        minChars: 2,
        maxChars: 20,
        editable: false,
      },
      run: async () => undefined,
    })
    controller.update("hello", {
      ...snapshot("hello"),
      origin: "assistant_message",
    })
    expect(controller.actionsFor(controller.current()!).map((action) => action.id)).toEqual(["translate"])
    controller.update("hello", {
      ...snapshot("hello"),
      source: "terminal",
      origin: "assistant_message",
    })
    expect(controller.actionsFor(controller.current()!)).toEqual([])
  })

  test("matches read-only Monaco selections as code from another origin", () => {
    const controller = new TextSelectionController()
    controller.registerAction({
      id: "explain-code",
      pluginId: "vibe-lingo",
      pluginName: "VibeLingo",
      label: "Explain code",
      order: 1,
      when: {
        sources: ["code"],
        origins: ["other"],
        editable: false,
      },
      run: async () => undefined,
    })
    controller.registerAction({
      id: "rewrite-code",
      pluginId: "vibe-lingo",
      pluginName: "VibeLingo",
      label: "Rewrite code",
      order: 2,
      when: {
        sources: ["code"],
        origins: ["editable"],
        editable: true,
      },
      run: async () => undefined,
    })

    controller.update("const answer = 42", {
      source: "code",
      origin: "other",
      editable: false,
      wholeContainer: false,
    })

    expect(controller.current()).toMatchObject({
      source: "code",
      origin: "other",
      editable: false,
      wholeContainer: false,
    })
    expect(controller.actionsFor(controller.current()!).map((action) => action.id)).toEqual(["explain-code"])
  })

  test("groups actions by plugin without collapsing duplicate local labels", () => {
    const groups = groupTextActions([
      {
        id: "alpha:translate",
        pluginId: "alpha",
        pluginName: "Alpha",
        label: "Translate",
        order: 2,
        run: async () => undefined,
      },
      {
        id: "beta:translate",
        pluginId: "beta",
        pluginName: "Beta",
        label: "Translate",
        order: 1,
        run: async () => undefined,
      },
      {
        id: "alpha:explain",
        pluginId: "alpha",
        pluginName: "Alpha",
        label: "Explain",
        order: 1,
        run: async () => undefined,
      },
    ])
    expect(groups.map((group) => [group.pluginName, group.actions.map((action) => action.id)])).toEqual([
      ["Alpha", ["alpha:explain", "alpha:translate"]],
      ["Beta", ["beta:translate"]],
    ])
  })
})
