import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { setupSolidDOM } from "../support/solid-dom"

const closeDOM = await setupSolidDOM()
afterAll(closeDOM)
const i18n = setupI18n({ locale: "en", messages: { en: {} } })
mock.module("@lingui/solid", () => ({ useLingui: () => ({ _: i18n._.bind(i18n) }) }))
const pending: Array<{ signal?: AbortSignal; resolve(value: string): void }> = []
const parse = (_text: string, signal?: AbortSignal) =>
  new Promise<string>((resolve) => pending.push({ signal, resolve }))
mock.module("../../src/context/marked", () => ({ useMarked: () => ({ parse, parseInline: parse }) }))

const { ToolObjectResult } = await import("../../src/components/tool-object-result")
const { UserMarkdown } = await import("../../src/components/user-markdown")
const { ResourceOpenProvider } = await import("../../src/context/resource-open")
const disposers: Array<() => void> = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  pending.length = 0
})
async function until<T>(read: () => T, expected: T) {
  const deadline = Date.now() + 2000
  while (read() !== expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(read()).toBe(expected)
}
function mount(component: () => ReturnType<typeof ToolObjectResult>) {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(component, root)
  disposers.push(dispose)
  return { root, dispose }
}
function button(root: Element, label: string) {
  const value = Array.from(root.querySelectorAll("button")).find((button) => button.textContent === label)
  expect(value).toBeDefined()
  return value!
}

test("structured results paginate real fields and reset when the result changes", () => {
  const [value, setValue] = createSignal<unknown>(
    Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`field-${i}`, i])),
  )
  const { root } = mount(() =>
    createComponent(ToolObjectResult, {
      get value() {
        return value()
      },
    }),
  )
  expect(root.querySelectorAll("dt")).toHaveLength(12)
  expect(button(root, "Previous results").disabled).toBe(true)
  button(root, "Next results").click()
  expect(Array.from(root.querySelectorAll("dt"), (node) => node.textContent)).toEqual(["field-12", "field-13"])
  expect(button(root, "Next results").disabled).toBe(true)
  button(root, "Previous results").click()
  expect(root.querySelector("dt")?.textContent).toBe("field-0")
  button(root, "Next results").click()
  setValue(["new first", "new second"])
  expect(root.querySelectorAll('[data-slot="tool-object-item"]')).toHaveLength(2)
  expect(root.textContent).toContain("new first")
  expect(root.querySelector("nav")).toBeNull()
})

test("nested results bound the first page and large values expand without altering the source", () => {
  const source = "中文😀".repeat(3000)
  const [value, setValue] = createSignal<unknown>({ rows: Array.from({ length: 8 }, (_, i) => ({ index: i, source })) })
  const { root } = mount(() =>
    createComponent(ToolObjectResult, {
      get value() {
        return value()
      },
    }),
  )
  expect(root.querySelectorAll('[data-slot="tool-object-item"]')).toHaveLength(6)
  expect(root.querySelector("pre")?.textContent).toHaveLength(8000)
  button(root, "Show full value").click()
  expect(root.querySelector("pre")?.textContent).toBe(JSON.stringify({ index: 0, source }, null, 2))
  setValue(source)
  expect(root.querySelector("pre")?.textContent).toHaveLength(8000)
  button(root, "Show full value").click()
  expect(root.querySelector("pre")?.textContent).toBe(source)
  setValue(undefined)
  expect(root.querySelector("pre")?.textContent).toBe("—")
})

test("user Markdown opens authoritative references and image resources without fetching images", async () => {
  const source =
    "# 中文 😀\n\n**src/main.ts**\n\n![示例](https://example.test/image.png)\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<img src=x onerror=alert(1)>"
  const start = source.indexOf("src/main.ts")
  const opened: unknown[] = []
  const references: number[] = []
  const { root } = mount(() =>
    createComponent(ResourceOpenProvider, {
      value: {
        open: async (value) => {
          opened.push(value)
          return { status: "opened" }
        },
      },
      get children() {
        return createComponent(UserMarkdown, {
          text: source,
          references: [{ start, end: start + 11 }],
          onOpenReference: (index) => references.push(index),
        })
      },
    }),
  )
  await until(() => root.querySelector("h1")?.textContent, "中文 😀")
  root.querySelector<HTMLButtonElement>("[data-user-reference]")!.click()
  expect(references).toEqual([0])
  root.querySelector<HTMLButtonElement>("[data-user-image]")!.click()
  await until(() => opened.length, 1)
  expect(opened[0]).toMatchObject({ kind: "url", url: "https://example.test/image.png", mime: "image/*" })
  expect(root.querySelectorAll("img,script,[onerror]")).toHaveLength(0)
  expect(root.querySelector('[data-slot="markdown-table-scroll"] table')).not.toBeNull()
  expect(root.textContent).toContain("<img src=x onerror=alert(1)>")
})

test("replaced Markdown and disposal cancel rendering and reject late content", async () => {
  const [text, setText] = createSignal("```js\nold()\n```")
  const { root, dispose } = mount(() =>
    createComponent(UserMarkdown, {
      get text() {
        return text()
      },
    }),
  )
  await until(() => pending.length, 1)
  setText("# Current draft")
  await until(() => root.querySelector("h1")?.textContent, "Current draft")
  expect(pending[0]!.signal?.aborted).toBe(true)
  pending[0]!.resolve("<pre>obsolete render</pre>")
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(root.textContent).toBe("Current draft")
  setText("```js\nnext()\n```")
  await until(() => pending.length, 2)
  dispose()
  expect(pending[1]!.signal?.aborted).toBe(true)
  pending[1]!.resolve("<pre>unmounted render</pre>")
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(root.childElementCount).toBe(0)
})
