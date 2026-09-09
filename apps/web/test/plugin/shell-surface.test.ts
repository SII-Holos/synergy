import { expect, test } from "bun:test"
import { createComponent, createSignal, onCleanup, type Component } from "solid-js"
import { render } from "solid-js/web"
import { ShellSurface } from "../../src/plugin/shell-surface"
import type { ShellEntry, ShellRenderProps } from "../../src/plugin/registries/shell-registry"

function element(text: string) {
  const node = document.createElement("div")
  node.textContent = text
  return node
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const shell = { page: () => "session" as const, render: () => element("host") }
const fallback: Component<ShellRenderProps> = () => element("fallback")
const flush = () => Bun.sleep(5)

test("releases the bound session immediately and ignores an old page load", async () => {
  const pending = deferred<{ default: Component<ShellRenderProps> }>()
  const released: string[] = []
  const entry: ShellEntry = {
    id: "test:main",
    pluginId: "test",
    slot: "app.shell",
    label: "Test",
    loader: async () => ({
      default: (props) => {
        const session = props.sessionId!
        onCleanup(() => released.push(session))
        return element(session)
      },
    }),
  }
  const [sessionId, setSessionId] = createSignal("a")
  const [loader, setLoader] = createSignal(entry.loader)
  const target = document.createElement("div")
  const errors: unknown[] = []
  const dispose = render(
    () =>
      createComponent(ShellSurface, {
        entry,
        shell,
        fallback,
        reportError: (error) => errors.push(error),
        get sessionId() {
          return sessionId()
        },
        get loader() {
          return loader()
        },
      }),
    target,
  )
  try {
    await flush()
    expect(target.textContent).toBe("a")
    setLoader(() => () => pending.promise)
    setSessionId("b")
    expect(released).toEqual(["a"])
    expect(target.textContent).toBe("fallback")
    setLoader(() => entry.loader)
    await flush()
    expect(target.textContent).toBe("b")
    pending.reject(new Error("stale failure"))
    await flush()
    expect(target.textContent).toBe("b")
    expect(errors).toEqual([])
  } finally {
    dispose()
  }
  expect(released).toEqual(["a", "b"])
})

test("attributes import and render errors and recovers when a shell is replaced", async () => {
  const broken: ShellEntry = {
    id: "bad:shell",
    pluginId: "bad",
    label: "Bad",
    slot: "app.shell",
    loader: async () => {
      throw new Error("import failed")
    },
  }
  const [entry, setEntry] = createSignal(broken)
  const errors: Array<{ pluginId: string; message: string }> = []
  const target = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(ShellSurface, {
        get entry() {
          return entry()
        },
        get loader() {
          return entry().loader
        },
        shell,
        fallback,
        reportError: (error) => errors.push(error),
      }),
    target,
  )
  try {
    await flush()
    expect(target.textContent).toBe("fallback")
    expect(errors).toEqual([{ pluginId: "bad", message: "import failed" }])
    setEntry({
      ...broken,
      loader: async () => ({
        default: () => {
          throw new Error("render failed")
        },
      }),
    })
    await flush()
    expect(target.textContent).toBe("fallback")
    expect(errors.at(-1)).toEqual({ pluginId: "bad", message: "render failed" })
    setEntry({ ...broken, loader: async () => ({ default: () => element("recovered") }) })
    await flush()
    expect(target.textContent).toBe("recovered")
  } finally {
    dispose()
  }
})

test("a Shell without its required outlet falls back and reports the missing contract", async () => {
  const { createExtensionOutlets, ExtensionOutletsProvider } = await import(
    "@ericsanchezok/synergy-ui/context/extension-outlet"
  )
  const target = document.createElement("div")
  const errors: Array<{ message: string }> = []
  const entry: ShellEntry = {
    id: "broken:shell",
    pluginId: "broken",
    slot: "app.shell",
    label: "Broken",
    loader: async () => ({ default: () => element("custom") }),
  }
  const dispose = render(
    () =>
      createComponent(ExtensionOutletsProvider, {
        value: createExtensionOutlets(),
        get children() {
          return createComponent(ShellSurface, {
            entry,
            loader: entry.loader,
            shell,
            fallback,
            requireOutlets: true,
            reportError: (error) => errors.push(error),
          })
        },
      }),
    target,
  )
  try {
    await flush()
    expect(target.textContent).toBe("fallback")
    expect(errors.map((error) => error.message)).toEqual(["Shell is missing required extension outlets: app.footer"])
  } finally {
    dispose()
  }
})
