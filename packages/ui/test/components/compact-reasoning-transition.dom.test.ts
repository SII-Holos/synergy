import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

// Solid initial transition memo fix: https://github.com/solidjs/solid/pull/2617
test("streaming reasoning remains readable while a new Match awaits a transition", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".reasoning-transition-"))
  const entry = path.join(directory, "main.tsx")
  const component = path.resolve(import.meta.dir, "../../src/components/compact-reasoning.tsx")
  const i18n = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  await Bun.write(
    entry,
    `
    import { createSignal, createResource, Suspense, Show, Switch, Match, ErrorBoundary, startTransition } from "solid-js"
    import { render } from "solid-js/web"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from ${JSON.stringify(i18n)}
    import { CompactReasoningLine } from ${JSON.stringify(component)}
    export function mount(root) {
      const errors = []
      let api
      function Probe() {
        const [visible, setVisible] = createSignal(false)
        const [text, setText] = createSignal("Planning the reply")
        let release, started
        const entered = new Promise(resolve => started = resolve)
        let calls = 0
        const [resource, { refetch }] = createResource(() => ++calls === 1 ? "ready" : new Promise(resolve => {
          release = () => resolve("ready")
          started()
        }))
        const item = { kind: "reasoning", part: { get text() { return text() } } }
        const Detail = props => <CompactReasoningLine fullText={props.item.part.text} running={false} />
        api = { errors, setText, entered, enter: () => startTransition(() => { setVisible(true); refetch() }), release: () => release() }
        return <ErrorBoundary fallback={error => { errors.push(error.message); return <pre>{error.message}</pre> }}>
          <Suspense fallback="loading"><span>{resource()}</span><Show when={visible()}><Switch>
            <Match when={item}>{value => <Detail item={value()} />}</Match>
          </Switch></Show></Suspense>
        </ErrorBoundary>
      }
      const dispose = render(() => <I18nProvider i18n={setupI18n()}><Probe /></I18nProvider>, root)
      return { ...api, dispose }
    }
  `,
  )
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/" })
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  }
  const descriptors = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  try {
    await build({
      configFile: false,
      logLevel: "silent",
      plugins: [solidPlugin()],
      build: {
        outDir: path.join(directory, "dist"),
        minify: false,
        lib: { entry, formats: ["es"], fileName: "fixture" },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    const fixture = (await import(pathToFileURL(path.join(directory, "dist/fixture.js")).href)) as {
      mount(root: Element): {
        enter(): Promise<void>
        entered: Promise<void>
        release(): void
        setText(text: string): void
        errors: string[]
        dispose(): void
      }
    }
    const harness = fixture.mount(document.getElementById("root")!)
    try {
      const pending = harness.enter()
      await harness.entered
      try {
        harness.setText("Stream update while navigation waits")
      } finally {
        harness.release()
        await pending
      }
      expect(harness.errors).toEqual([])
      expect(document.body.textContent).toContain("Stream update while navigation waits")
    } finally {
      harness.dispose()
    }
  } finally {
    dom.window.close()
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
