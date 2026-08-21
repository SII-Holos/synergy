import { afterEach, describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { ErrorBoundary, createComponent, type JSX } from "solid-js"

mock.module("@lingui/solid", () => ({
  useLingui: () => ({
    _: (descriptor: { id: string; message?: string }) => descriptor.message ?? descriptor.id,
  }),
}))

// PluginErrorBoundary is a JSX component; bun's test transform compiles JSX to
// React.createElement in this harness (see font-preference-provider.test.ts for
// the same convention). Substitute a real Solid error boundary so the outlet's
// lazy-load/dispose logic — including the loader-failure error card — stays
// exercised. The boundary's own rendering is covered by the app.
mock.module("../../../src/plugin/components/plugin-error-boundary", () => ({
  PluginErrorBoundary: (props: { pluginId?: string; componentName?: string; children?: unknown }) =>
    createComponent(ErrorBoundary, {
      fallback: (error: unknown) => {
        const element = document.createElement("div")
        element.dataset.testid = "plugin-error"
        element.textContent = error instanceof Error ? error.message : String(error)
        return element
      },
      // Getter children, mirroring the JSX compile output of the real boundary:
      // children must be created inside the ErrorBoundary's protected scope so
      // render errors from the outlet's Dynamic component are caught.
      get children() {
        return props.children as JSX.Element
      },
    }),
}))

const { SlotOutlet } = await import("../../../src/plugin/slot-outlet")
const { SlotRegistry } = await import("../../../src/plugin/slot-registry")

function registry() {
  return new SlotRegistry()
}

function node(testid: string, text: string) {
  const element = document.createElement("div")
  element.dataset.testid = testid
  element.textContent = text
  return element
}

function entryComponent() {
  return () => node("slot-entry", "hi")
}

function simpleEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "test:entry",
    label: "Test entry",
    slot: "sidebar.footer",
    pluginId: "test",
    loader: async () => ({ default: entryComponent() }),
    ...overrides,
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe("SlotOutlet", () => {
  test("renders fallback when the slot is empty", async () => {
    const reg = registry()
    const target = document.createElement("div")
    document.body.append(target)
    const dispose = render(
      () =>
        createComponent(SlotOutlet, {
          slot: "sidebar.footer",
          fallback: node("fallback", "none"),
          registry: reg,
        }),
      target,
    )
    expect(target.querySelector('[data-testid="fallback"]')?.textContent).toBe("none")
    expect(target.querySelector('[data-testid="slot-entry"]')).toBeNull()
    dispose()
  })

  test("renders registered entries and removes them on unregister", async () => {
    const reg = registry()
    const target = document.createElement("div")
    document.body.append(target)
    const dispose = render(() => createComponent(SlotOutlet, { slot: "sidebar.footer", registry: reg }), target)
    const unregister = reg.register(simpleEntry())
    for (let attempt = 0; attempt < 20 && !target.querySelector('[data-testid="slot-entry"]'); attempt++) {
      await Bun.sleep(1)
    }
    expect(target.querySelector('[data-testid="slot-entry"]')?.textContent).toBe("hi")
    unregister()
    for (let attempt = 0; attempt < 20 && target.querySelector('[data-testid="slot-entry"]'); attempt++) {
      await Bun.sleep(1)
    }
    expect(target.querySelector('[data-testid="slot-entry"]')).toBeNull()
    dispose()
  })

  test("does not mount a stale loader after unregister", async () => {
    const reg = registry()
    let resolveLoader!: (value: { default: () => unknown }) => void
    const pending = new Promise<{ default: () => unknown }>((done) => {
      resolveLoader = done
    })
    const target = document.createElement("div")
    document.body.append(target)
    const dispose = render(() => createComponent(SlotOutlet, { slot: "sidebar.footer", registry: reg }), target)
    const unregister = reg.register(simpleEntry({ loader: () => pending }))
    unregister()
    resolveLoader({ default: () => node("slot-entry", "late") })
    await Bun.sleep(5)
    expect(target.querySelector('[data-testid="slot-entry"]')).toBeNull()
    dispose()
  })

  test("applies when.session filtering", async () => {
    const reg = registry()
    const withSession = reg.register(simpleEntry({ id: "test:session", when: { session: true } }))
    const without = reg.register(simpleEntry({ id: "test:any" }))
    const target = document.createElement("div")
    document.body.append(target)
    const dispose = render(
      () => createComponent(SlotOutlet, { slot: "sidebar.footer", session: false, registry: reg }),
      target,
    )
    for (let attempt = 0; attempt < 20 && !target.querySelector('[data-testid="slot-entry"]'); attempt++) {
      await Bun.sleep(1)
    }
    // Only the session-less entry renders; the session-gated one is filtered out.
    expect(target.querySelectorAll('[data-testid="slot-entry"]')).toHaveLength(1)
    withSession()
    without()
    dispose()
  })

  test("sorts entries by order then id", async () => {
    const reg = registry()
    const unregisterB = reg.register(simpleEntry({ id: "test:z", order: 20 }))
    const unregisterA = reg.register(simpleEntry({ id: "test:a", order: 10 }))
    const target = document.createElement("div")
    document.body.append(target)
    const dispose = render(() => createComponent(SlotOutlet, { slot: "sidebar.footer", registry: reg }), target)
    for (let attempt = 0; attempt < 20 && target.querySelectorAll('[data-testid="slot-entry"]').length < 2; attempt++) {
      await Bun.sleep(1)
    }
    const texts = Array.from(target.querySelectorAll('[data-testid="slot-entry"]')).map((el) => el.textContent)
    expect(texts).toEqual(["hi", "hi"])
    unregisterA()
    unregisterB()
    dispose()
  })
  test("renders the error card when a loader rejects", async () => {
    const reg = registry()
    const target = document.createElement("div")
    document.body.append(target)
    const dispose = render(() => createComponent(SlotOutlet, { slot: "sidebar.footer", registry: reg }), target)
    const unregister = reg.register(
      simpleEntry({
        loader: async () => {
          throw new Error("boom")
        },
      }),
    )
    for (let attempt = 0; attempt < 20 && !target.querySelector('[data-testid="plugin-error"]'); attempt++) {
      await Bun.sleep(1)
    }
    expect(target.querySelector('[data-testid="plugin-error"]')?.textContent).toBe("boom")
    unregister()
    dispose()
  })

  test("recovers from a failed load when the entry is replaced", async () => {
    const reg = registry()
    const target = document.createElement("div")
    document.body.append(target)
    const dispose = render(() => createComponent(SlotOutlet, { slot: "sidebar.footer", registry: reg }), target)
    const unregisterBad = reg.register(
      simpleEntry({
        id: "test:flaky",
        loader: async () => {
          throw new Error("first load failed")
        },
      }),
    )
    for (let attempt = 0; attempt < 20 && !target.querySelector('[data-testid="plugin-error"]'); attempt++) {
      await Bun.sleep(1)
    }
    expect(target.querySelector('[data-testid="plugin-error"]')?.textContent).toBe("first load failed")

    // Reload the same slot with a healthy entry: the stale error card must go away.
    unregisterBad()
    const unregisterGood = reg.register(simpleEntry({ id: "test:flaky" }))
    for (let attempt = 0; attempt < 20 && !target.querySelector('[data-testid="slot-entry"]'); attempt++) {
      await Bun.sleep(1)
    }
    expect(target.querySelector('[data-testid="slot-entry"]')?.textContent).toBe("hi")
    expect(target.querySelector('[data-testid="plugin-error"]')).toBeNull()
    unregisterGood()
    dispose()
  })
})
