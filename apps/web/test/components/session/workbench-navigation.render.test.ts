import { expect, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { createComponent, createRoot, createSignal, useContext } from "solid-js"
import { Portal, render } from "solid-js/web"

await plugin({
  name: "workbench-navigation-render",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (await transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          [import.meta.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
        ],
        sourceMaps: "inline",
      }))!.code!,
      loader: "js",
    }))
  },
})

const { SidebarNavigation } = await import("../../../src/components/sidebar/sidebar-navigation")
const { DefaultSession } = await import("../../../src/plugin/default-session")
const { SessionWorkbenchChrome } = await import("../../../src/components/session/workbench-chrome")

test("navigation keeps its toggle while moving new-task access into the collapsed toolbar", () => {
  const [expanded, setExpanded] = createSignal(true)
  const [notice, setNotice] = createSignal<string | undefined>("Update available")
  const actions: string[] = []
  const root = document.createElement("div")
  const brand = document.createElement("span")
  brand.textContent = "Synergy"
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(SidebarNavigation, {
        get expanded() {
          return expanded()
        },
        get notice() {
          return notice()
        },
        labels: { expand: "Expand sidebar", collapse: "Collapse sidebar", search: "Search", newSession: "New task" },
        onToggle: () => {
          actions.push("toggle")
          setExpanded(!expanded())
        },
        onSearch: () => actions.push("search"),
        onNew: () => actions.push("new"),
        children: brand,
      }),
    root,
  )
  const button = (name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  try {
    const toggle = button("Collapse sidebar")!
    const icon = toggle.querySelector("svg")!
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(root.querySelector('[role="status"]')).toBeNull()
    expect(button("New task")).toBeNull()
    button("Search")!.click()
    toggle.click()
    expect(button("Expand sidebar")).toBe(toggle)
    expect(toggle.querySelector("svg")).toBe(icon)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(root.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Update available")
    expect(brand.isConnected).toBe(true)
    button("New task")!.click()
    button("Search")!.click()
    setNotice(undefined)
    expect(root.querySelector('[role="status"]')).toBeNull()
    toggle.click()
    expect(button("Collapse sidebar")).toBe(toggle)
    expect(button("New task")).toBeNull()
    expect(actions).toEqual(["search", "toggle", "new", "search", "toggle"])
  } finally {
    dispose()
    root.remove()
  }
})

test("session controls remain in their owning chrome without replacing the composer on layout updates", () => {
  const [minimumWidth, setMinimumWidth] = createSignal<number | undefined>()
  const [promptHeight, setPromptHeight] = createSignal(80)
  const mount = (name: string) => {
    const root = document.createElement("div")
    const action = document.createElement("button")
    action.textContent = name
    const composer = document.createElement("textarea")
    composer.value = `Draft for ${name}`
    document.body.append(root)
    const Controls = () => {
      const chrome = useContext(SessionWorkbenchChrome)
      if (!chrome) throw new Error("Session chrome must be provided to its views")
      return createComponent(Portal, {
        get mount() {
          return chrome()
        },
        children: action,
      })
    }
    const dispose = render(
      () =>
        createComponent(DefaultSession, {
          context: {
            layout: {
              minimumWidth,
              promptHeight,
              render: (part) =>
                part === "conversation" ? createComponent(Controls, {}) : part === "composer" ? composer : null,
            },
          },
        }),
      root,
    )
    return { root, action, composer, dispose }
  }
  const first = mount("First session")
  const second = mount("Second session")
  try {
    const firstChrome = first.root.querySelector(".session-workbench-controls")!
    const secondChrome = second.root.querySelector(".session-workbench-controls")!
    expect(firstChrome.contains(first.action)).toBe(true)
    expect(firstChrome.contains(second.action)).toBe(false)
    expect(secondChrome.contains(second.action)).toBe(true)
    expect(firstChrome).not.toBe(secondChrome)
    setMinimumWidth(360)
    setPromptHeight(120)
    const pane = first.root.querySelector<HTMLElement>(".session-workbench-pane")!
    expect(pane.style.minWidth).toBe("360px")
    expect(pane.style.getPropertyValue("--prompt-height")).toBe("120px")
    expect(first.root.querySelector("textarea")).toBe(first.composer)
    expect(first.composer.value).toBe("Draft for First session")
    expect(firstChrome.contains(first.action)).toBe(true)
    first.dispose()
    expect(first.action.isConnected).toBe(false)
    expect(secondChrome.contains(second.action)).toBe(true)
    createRoot((dispose) => {
      expect(useContext(SessionWorkbenchChrome)).toBeUndefined()
      dispose()
    })
  } finally {
    first.dispose()
    second.dispose()
    first.root.remove()
    second.root.remove()
  }
})
