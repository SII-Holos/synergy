import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { clearWorkbenchPanels, listWorkbenchPanels } from "../../../src/plugin/registries/workbench-panel-registry"

// bun's test transform compiles JSX to React.createElement in this harness.
// The provider's own JSX (return <>{props.children}</>, tabIcon FileIcon) is
// never rendered here — we drive the provider as a plain function inside
// createRoot so its registration effect runs — so a minimal React shim is
// enough for the compiled createElement calls.
;(globalThis as unknown as { React: unknown }).React = {
  createElement: () => null,
  Fragment: Symbol("Fragment"),
}

const [activeLocale, setActiveLocale] = createSignal("en")

mock.module("@/context/terminal", () => ({
  useTerminal: () => ({ new: async () => undefined, all: () => [], close: async () => {} }),
}))
mock.module("@/context/file", () => ({
  useFile: () => ({ explorer: { setOpen: () => {} } }),
}))
mock.module("@/context/locale", () => ({
  useLocale: () => ({
    controller: { activeLocale },
    i18n: {
      _: (descriptor: { id: string; message?: string }) => descriptor.message ?? descriptor.id,
    },
  }),
}))

const { BuiltinWorkbenchPanelsProvider } = await import("../../../src/components/workspace/builtin-workbench-panels")

const BUILTIN_PANEL_IDS = [
  "notes",
  "context",
  "session-review",
  "lattice",
  "boss",
  "attachment",
  "file",
  "browser",
  "terminal",
]

function panelIds(): string[] {
  return listWorkbenchPanels().map((panel) => panel.id)
}

afterEach(() => {
  clearWorkbenchPanels()
})

describe("built-in workbench panels", () => {
  test("re-registers on locale change without duplicate-id throws", async () => {
    const dispose = createRoot((done) => {
      BuiltinWorkbenchPanelsProvider({ children: null })
      return done
    })
    try {
      for (let attempt = 0; attempt < 20 && panelIds().length < BUILTIN_PANEL_IDS.length; attempt++) {
        await Bun.sleep(1)
      }
      expect(panelIds().toSorted()).toEqual([...BUILTIN_PANEL_IDS].toSorted())

      // Simulate a runtime language switch: the registration effect re-runs
      // and re-registers the same panel ids. Before the fix this threw
      // "Duplicate slot entry" because the previous disposers were only run
      // after the new registrations.
      setActiveLocale("zh-CN")
      for (let attempt = 0; attempt < 20; attempt++) {
        await Bun.sleep(1)
        const ids = panelIds()
        if (ids.length === BUILTIN_PANEL_IDS.length && ids.filter((id) => id === "notes").length === 1) break
      }
      expect(panelIds().toSorted()).toEqual([...BUILTIN_PANEL_IDS].toSorted())
      expect(new Set(panelIds()).size).toBe(panelIds().length)
    } finally {
      dispose()
    }
  })
})
