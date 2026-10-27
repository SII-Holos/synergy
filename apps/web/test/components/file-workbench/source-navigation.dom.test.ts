import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

type SourceFixture = {
  sourceEditor(): Promise<import("monaco-editor").editor.IStandaloneCodeEditor>
  sourceLoadAttempts: number
  finishSourceLoad(outcome: "resolve" | "reject"): void
  setSourceMounted(value: boolean): void
  setWordWrap(value: boolean | undefined): void
  sourceDraft(): { content: string; baseContent: string } | undefined
  sourceDirtyChanges: boolean[]
  sourceIdentity?: {
    editor: import("monaco-editor").editor.IStandaloneCodeEditor
    model: import("monaco-editor").editor.ITextModel
    host: HTMLElement | null
    focused: Element | null
  }
}

let browser: Browser, page: Page, server: ViteDevServer, directory: string, url: string
const errors: string[] = []

async function finishSourceLoad(outcome: "resolve" | "reject") {
  await page.evaluate(async (value) => {
    ;(window as unknown as SourceFixture).finishSourceLoad(value)
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }, outcome)
}

async function sourceSnapshot() {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const fixture = window as unknown as SourceFixture
    const editor = await fixture.sourceEditor()
    const model = editor.getModel()!
    const visible = editor.getVisibleRanges()[0]!
    const start = editor.getScrolledVisiblePosition({ lineNumber: visible.startLineNumber, column: 1 })!
    const end = editor.getScrolledVisiblePosition({ lineNumber: visible.startLineNumber, column: 150 })!
    const composer = document.querySelector<HTMLInputElement>('input[aria-label="Composer"]')!
    return {
      state: {
        sameEditor: editor === fixture.sourceIdentity?.editor,
        sameModel: model === fixture.sourceIdentity?.model,
        sameHost: editor.getDomNode() === fixture.sourceIdentity?.host,
        sameFocus: document.activeElement === fixture.sourceIdentity?.focused,
        editorFocused: editor.hasTextFocus(),
        content: model.getValue(),
        version: model.getAlternativeVersionId(),
        selections: editor.getSelections(),
        canUndo: model.canUndo(),
        canRedo: model.canRedo(),
        draft: fixture.sourceDraft(),
        dirtyChanges: [...fixture.sourceDirtyChanges],
        composer: [composer.value, composer.selectionStart, composer.selectionEnd],
      },
      reading: {
        line: visible.startLineNumber,
        offset: editor.getTopForLineNumber(visible.startLineNumber) - editor.getScrollTop(),
      },
      layout: {
        wrapped: end.top > start.top,
        horizontalOverflow: editor.getScrollWidth() > editor.getLayoutInfo().contentWidth,
        visibleContinuation: Array.from(editor.getDomNode()!.querySelectorAll(".view-line")).some(
          (element) => element.textContent?.includes("wrap-segment") && !/const\s+sample\d+/.test(element.textContent),
        ),
      },
    }
  })
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".source-navigation-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  const bridge = path.join(directory, "bridge.ts")
  await Bun.write(
    bridge,
    `
    import { createSignal } from "solid-js"
    const [navigation, setNavigation] = createSignal()
    export const [draft, setDraft] = createSignal()
    const parameters = new URLSearchParams(location.search)
    const pendingLoads = []
    window.sourceLoadAttempts = 0
    window.loadSourceWorker = load => {
      window.sourceLoadAttempts += 1
      if (!parameters.has("loader")) return load()
      return new Promise((resolve, reject) => pendingLoads.push({ load, resolve, reject }))
    }
    window.finishSourceLoad = outcome => {
      const pending = pendingLoads.shift()
      if (!pending) throw new Error("No source load is pending")
      if (outcome === "reject") pending.reject(new Error("Injected transient source loader failure"))
      else pending.resolve(pending.load())
    }
    export const [wordWrap, setWordWrap] = createSignal(parameters.has("wrap") ? parameters.get("wrap") === "true" : undefined)
    export const editable = parameters.has("editable")
    export const dirtyChanges = []
    window.setWordWrap = setWordWrap
    window.sourceDraft = draft
    window.sourceDirtyChanges = dirtyChanges
    export const useFile = () => ({
      resourceKey: "source-navigation", navigation,
      draft: { get: draft, update: (_, content) => setDraft(previous => ({ ...previous, content })) },
      view: { sourceScrollTop: () => 0, sourceScrollLeft: () => 0, selectedLines: () => undefined,
        setSourceScroll() {}, setSelectedLines() {} },
    })
    export const useLingui = () => ({ _: value => value.message })
    export const useTheme = () => ({ tokens: () => ({}), mode: () => "light" })
    export const resolveThemeColor = (_, token) => token.startsWith("surface") ? "#ffffff" : "#222222"
    let finish
    export const start = event => { const origin = event.currentTarget; finish = () => setNavigation({ id: Date.now(),
      location: { kind: "text", line: 120 }, focusTarget: () => origin }) }
    window.finishReference = () => finish?.()
    window.agentReference = () => setNavigation({ id: Date.now(), origin: "agent", location: { kind: "text", line: 120 } })
  `,
  )
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { start, setDraft, wordWrap, editable, dirtyChanges } from "./bridge"
    import { FileSourceView } from ${JSON.stringify(`/@fs/${source}/components/file-workbench/source-view.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/components/file-workbench/styles.css`)}
    const suffix = new URLSearchParams(location.search).has("long") ? "; // " + "wrap-segment ".repeat(18) : ""
    const content = Array.from({length: 200}, (_, i) => "const sample" + (i+1) + " = " + (i+1) + suffix).join("\\n")
    if (editable) setDraft({ content: new URLSearchParams(location.search).has("draft") ? content + "\\nexisting draft" : content, baseContent: content })
    const [mounted, setMounted] = createSignal(true)
    window.setSourceMounted = setMounted
    window.sourceEditor = async () => (await import("monaco-editor/editor/editor.api.js")).editor.getEditors()[0]
    window.editorSelection = async () => (await window.sourceEditor()).getSelection()
    render(() => <><button data-resource-reference="a.ts#L120" onClick={start}>First reference</button>
      <button data-resource-reference="b.ts#L2">Next reference</button><input aria-label="Composer" />
      <style>{"* { box-sizing: border-box } .file-source-view { width: 700px; height: 420px } [data-component=spinner] { width: 20px; height: 20px } [data-component=file-icon] { width: 40px; height: 40px }"}</style>
      <Show when={mounted()}><FileSourceView path="a.ts" content={content} wordWrap={wordWrap()} editable={editable}
        onDirtyChange={dirty => dirtyChanges.push(dirty)} /></Show></>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [
      {
        name: "source-loader-fault",
        enforce: "pre",
        transform(code, id) {
          if (id !== path.join(source, "components/file-workbench/source-view.tsx")) return
          return code.replace(
            'import("monaco-editor/editor/editor.worker?worker")',
            'window.loadSourceWorker(() => import("monaco-editor/editor/editor.worker?worker"))',
          )
        },
      },
      solid(),
    ],
    resolve: {
      alias: [
        { find: "@/context/file", replacement: bridge },
        { find: "@ericsanchezok/synergy-ui/theme", replacement: bridge },
        { find: "@lingui/solid", replacement: bridge },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "monaco-editor/editor/editor.api.js"],
      noDiscovery: true,
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(source, "../../.."), directory] },
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.each(["retry", "remount"])(
  "source loader failure recovers without losing drafts or focus: %s",
  async (recovery) => {
    errors.length = 0
    await page.goto(`${url}?loader=1&editable=1&draft=1`)
    await page.waitForFunction(() => (window as unknown as SourceFixture).sourceLoadAttempts === 1)
    const composer = page.getByRole("textbox", { name: "Composer" })
    await page.getByRole("button", { name: "First reference", exact: true }).click()
    await page.evaluate(() => Reflect.get(window, "finishReference")())
    await composer.fill("composer draft")
    await composer.press("ArrowLeft")
    const draft = await page.evaluate(() => (window as unknown as SourceFixture).sourceDraft())
    if (!draft) throw new Error("The source fixture must start with an unsaved draft")
    expect(await page.getByText("Loading source viewer…", { exact: true }).isVisible()).toBe(true)

    await finishSourceLoad("reject")
    const retry = page.getByRole("button", { name: "Retry", exact: true })
    expect({
      failed: await page.getByText("Unable to open file", { exact: true }).isVisible(),
      retry: await retry.isVisible(),
      spinner: await page.locator('[data-component="spinner"]').count(),
      errors: [...errors],
    }).toEqual({ failed: true, retry: true, spinner: 0, errors: [] })
    expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as SourceFixture).sourceDraft())).toEqual(draft)

    if (recovery === "retry") {
      await retry.focus()
      await retry.press("Enter")
    } else {
      await page.evaluate(() => (window as unknown as SourceFixture).setSourceMounted(false))
      await page.evaluate(() => (window as unknown as SourceFixture).setSourceMounted(true))
    }
    await page.waitForFunction(() => (window as unknown as SourceFixture).sourceLoadAttempts === 2)
    expect(await retry.count()).toBe(0)
    expect(await page.getByText("Loading source viewer…", { exact: true }).isVisible()).toBe(true)
    await composer.focus()
    await finishSourceLoad("resolve")
    await page.locator(".monaco-editor .view-lines").waitFor()
    await page.waitForFunction(() => !document.querySelector('[data-component="spinner"]'))
    const recovered = await sourceSnapshot()
    expect(recovered.state.content).toBe(draft.content)
    expect(recovered.state.draft).toEqual(draft)
    expect(recovered.state.dirtyChanges).toEqual([])
    expect(recovered.state.composer).toEqual(["composer draft", 13, 13])
    expect(recovered.state.editorFocused).toBe(false)
    expect(recovered.state.selections?.[0]?.startLineNumber).toBe(120)
    expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(await retry.count()).toBe(0)

    await page.evaluate(async () => (await (window as unknown as SourceFixture).sourceEditor()).focus())
    await page.keyboard.insertText("x")
    expect((await sourceSnapshot()).state.draft?.content).not.toBe(draft.content)
    await page.keyboard.press("ControlOrMeta+z")
    expect((await sourceSnapshot()).state.content).toBe(draft.content)
    expect((await sourceSnapshot()).state.canRedo).toBe(true)
    expect(errors).toEqual([])
  },
  30_000,
)

test.each(["resolve", "reject"] as const)(
  "disposed source views ignore late loader settlement: %s",
  async (outcome) => {
    errors.length = 0
    await page.goto(`${url}?loader=1&editable=1&draft=1`)
    await page.waitForFunction(() => (window as unknown as SourceFixture).sourceLoadAttempts === 1)
    const composer = page.getByRole("textbox", { name: "Composer" })
    await composer.fill("keep focus")
    const draft = await page.evaluate(() => (window as unknown as SourceFixture).sourceDraft())
    if (!draft) throw new Error("The source fixture must start with an unsaved draft")
    await page.evaluate(() => (window as unknown as SourceFixture).setSourceMounted(false))
    await finishSourceLoad(outcome)
    await page.waitForLoadState("networkidle")
    expect(await page.locator(".file-source-view, .monaco-editor").count()).toBe(0)
    expect(await page.evaluate(async () => Boolean(await (window as unknown as SourceFixture).sourceEditor()))).toBe(
      false,
    )
    expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as SourceFixture).sourceDraft())).toEqual(draft)
    expect(await page.evaluate(() => (window as unknown as SourceFixture).sourceDirtyChanges)).toEqual([])
    expect(errors).toEqual([])

    await page.evaluate(() => (window as unknown as SourceFixture).setSourceMounted(true))
    if (outcome === "reject") {
      await page.waitForFunction(() => (window as unknown as SourceFixture).sourceLoadAttempts === 2)
      await finishSourceLoad("resolve")
    }
    await page.locator(".monaco-editor .view-lines").waitFor()
    expect(await page.evaluate(() => (window as unknown as SourceFixture).sourceLoadAttempts)).toBe(
      outcome === "reject" ? 2 : 1,
    )
    expect((await sourceSnapshot()).state.content).toBe(draft.content)
    expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(errors).toEqual([])
  },
  30_000,
)

test("native worker module evaluation failure stays actionable until reload", async () => {
  errors.length = 0
  const workerModule = /editor\.worker[^?]*\?worker(?:&|$)/
  let failures = 0
  await page.route(workerModule, async (route) => {
    failures += 1
    await route.fulfill({
      contentType: "application/javascript",
      body: 'throw new Error("Injected worker import failure")',
    })
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor()
    expect(failures).toBe(1)
    expect(
      await page
        .getByText("Retry, or reload this page if the source viewer still cannot load.", { exact: true })
        .isVisible(),
    ).toBe(true)
    expect(await page.locator('[data-component="spinner"]').count()).toBe(0)
    await page.unroute(workerModule)
    await page.getByRole("button", { name: "Retry", exact: true }).press("Enter")
    await page.waitForFunction(() => (window as unknown as SourceFixture).sourceLoadAttempts === 2)
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor()
    expect(await page.getByText("Unable to open file", { exact: true }).isVisible()).toBe(true)
    expect(await page.locator('.monaco-editor, [data-component="spinner"]').count()).toBe(0)
    expect(errors).toEqual([])
    await page.reload()
    await page.locator(".monaco-editor .view-lines").waitFor()
    expect(errors).toEqual([])
  } finally {
    await page.unroute(workerModule)
  }
}, 30_000)

test.each(["Next reference", "Composer", "First reference"])(
  "late navigation preserves the current focus owner: %s",
  async (target) => {
    errors.length = 0
    await page.goto(url)
    await page.locator(".monaco-editor .view-lines").waitFor()
    await page.getByRole("button", { name: "First reference", exact: true }).click()
    const control =
      target === "Composer"
        ? page.getByRole("textbox", { name: "Composer" })
        : page.getByRole("button", { name: target, exact: true })
    await control.focus()
    await page.evaluate(() => (window as unknown as { finishReference(): void }).finishReference())
    await page.waitForFunction(() =>
      document.querySelector(".monaco-editor .view-lines")?.textContent?.includes("sample120"),
    )
    if (target === "First reference")
      expect(await page.locator(".monaco-editor").evaluate((el) => el.contains(document.activeElement))).toBe(true)
    else expect(await control.evaluate((el) => el === document.activeElement)).toBe(true)
    expect(errors).toEqual([])
  },
  30_000,
)

test.each(["Composer", "Editor", "Body"])(
  "Agent navigation preserves focus and caret: %s",
  async (target) => {
    errors.length = 0
    await page.goto(url)
    const editor = page.locator(".monaco-editor")
    await editor.locator(".view-lines").waitFor()
    if (target === "Composer") {
      const composer = page.getByRole("textbox", { name: "Composer" })
      await composer.fill("composer draft")
      await composer.press("ArrowLeft")
    } else if (target === "Editor") {
      await editor.locator("textarea").focus()
      await page.keyboard.press("ArrowRight")
      await page.keyboard.press("ArrowRight")
    } else await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    const before = await page.evaluate(async () => {
      const focused = document.activeElement
      return {
        selection: await Reflect.get(window, "editorSelection")(),
        focus: focused?.tagName,
        composer:
          focused instanceof HTMLInputElement
            ? [focused.value, focused.selectionStart, focused.selectionEnd]
            : undefined,
      }
    })
    await page.evaluate(() => Reflect.get(window, "agentReference")())
    await page.waitForFunction(() =>
      document.querySelector(".monaco-editor .view-lines")?.textContent?.includes("sample120"),
    )
    const after = await page.evaluate(async () => {
      const focused = document.activeElement
      return {
        selection: await Reflect.get(window, "editorSelection")(),
        focus: focused?.tagName,
        composer:
          focused instanceof HTMLInputElement
            ? [focused.value, focused.selectionStart, focused.selectionEnd]
            : undefined,
      }
    })
    expect(after.focus).toBe(before.focus)
    expect(after.composer).toEqual(before.composer)
    if (target === "Editor") expect(after.selection).toEqual(before.selection)
    else expect(await editor.evaluate((element) => element.contains(document.activeElement))).toBe(false)
    expect(errors).toEqual([])
  },
  30000,
)

test.each([
  ["default", undefined],
  ["enabled", true],
  ["disabled", false],
] as const)(
  "initial source wrapping uses the requested value: %s",
  async (_label, wordWrap) => {
    errors.length = 0
    await page.goto(`${url}?long=1${wordWrap === undefined ? "" : `&wrap=${wordWrap}`}`)
    await page.locator(".monaco-editor .view-lines").waitFor()
    const snapshot = await sourceSnapshot()
    expect(snapshot.layout).toEqual({
      wrapped: wordWrap !== false,
      horizontalOverflow: wordWrap === false,
      visibleContinuation: wordWrap !== false,
    })
    expect(errors).toEqual([])
  },
  30_000,
)

test.each(["Composer", "Editor"])(
  "source wrap changes preserve reading, editing state and focus: %s",
  async (target) => {
    errors.length = 0
    await page.goto(`${url}?long=1&wrap=false&editable=1`)
    await page.locator(".monaco-editor .view-lines").waitFor()
    await page.evaluate(async () => {
      const editor = await (window as unknown as SourceFixture).sourceEditor()
      editor.setPosition({ lineNumber: 80, column: 1 })
      editor.revealLineInCenter(80)
      editor.pushUndoStop()
      editor.focus()
    })
    await page.keyboard.insertText("x")
    await page.evaluate(async () => {
      const editor = await (window as unknown as SourceFixture).sourceEditor()
      editor.pushUndoStop()
      editor.setSelection({
        selectionStartLineNumber: 80,
        selectionStartColumn: 24,
        positionLineNumber: 80,
        positionColumn: 7,
      })
      editor.setScrollPosition({ scrollTop: editor.getTopForLineNumber(80), scrollLeft: 0 })
    })
    if (target === "Composer") {
      const composer = page.getByRole("textbox", { name: "Composer" })
      await composer.fill("composer draft")
      await composer.press("ArrowLeft")
    }
    await page.evaluate(async () => {
      const fixture = window as unknown as SourceFixture
      const editor = await fixture.sourceEditor()
      fixture.sourceIdentity = {
        editor,
        model: editor.getModel()!,
        host: editor.getDomNode(),
        focused: document.activeElement,
      }
    })
    const before = await sourceSnapshot()
    expect(before.reading.line).toBe(80)
    expect(before.state.editorFocused).toBe(target === "Editor")
    expect(before.state.canUndo).toBe(true)
    expect(before.state.dirtyChanges.length).toBeGreaterThan(0)
    expect(before.state.dirtyChanges.every(Boolean)).toBe(true)
    expect(before.state.draft?.content).toBe(before.state.content)
    expect(before.state.draft?.content).not.toBe(before.state.draft?.baseContent)

    for (const wordWrap of [true, false, undefined]) {
      await page.evaluate((value) => (window as unknown as SourceFixture).setWordWrap(value), wordWrap)
      const after = await sourceSnapshot()
      expect(after.layout).toEqual({
        wrapped: wordWrap !== false,
        horizontalOverflow: wordWrap === false,
        visibleContinuation: wordWrap !== false,
      })
      expect(after.state).toEqual(before.state)
      expect(after.reading.line).toBe(before.reading.line)
      expect(Math.abs(after.reading.offset - before.reading.offset)).toBeLessThan(1)
    }

    await page.evaluate(async () => (await (window as unknown as SourceFixture).sourceEditor()).focus())
    await page.keyboard.press("ControlOrMeta+z")
    const undone = await sourceSnapshot()
    if (!before.state.draft) throw new Error("The editable fixture did not capture a draft baseline")
    expect(undone.state.content).toBe(before.state.draft.baseContent)
    expect(undone.state.draft?.content).toBe(before.state.draft.baseContent)
    expect(undone.state.dirtyChanges).toEqual([...before.state.dirtyChanges, false])
    expect(undone.state.canRedo).toBe(true)
    await page.keyboard.press("ControlOrMeta+Shift+z")
    const redone = await sourceSnapshot()
    expect(redone.state.content).toBe(before.state.content)
    expect(redone.state.draft).toEqual(before.state.draft)
    expect(redone.state.dirtyChanges).toEqual([...before.state.dirtyChanges, false, true])
    expect(errors).toEqual([])
  },
  30_000,
)
