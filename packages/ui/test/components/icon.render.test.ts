import { afterAll, afterEach, expect, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { setupSolidDOM } from "../support/solid-dom"

const closeDOM = await setupSolidDOM()
afterAll(closeDOM)
const { Icon } = await import("../../src/components/icon")
const { registerIcon } = await import("../../src/plugin/icon-registry")
const disposers: Array<() => void> = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("selected integration glyphs render with the host size and paint", () => {
  const root = document.createElement("div")
  document.body.append(root)
  disposers.push(
    render(
      () => [
        createComponent(Icon, { name: "tabler-photo-edit", size: "small" }),
        createComponent(Icon, { name: "brand-notion", size: "large" }),
      ],
      root,
    ),
  )
  const [photo, notion] = root.querySelectorAll("[data-component=icon]")
  expect(photo?.getAttribute("data-size")).toBe("small")
  expect(photo?.querySelectorAll("path")).toHaveLength(5)
  expect(notion?.getAttribute("data-size")).toBe("large")
  expect(notion?.querySelector("svg")?.getAttribute("fill")).toBe("currentColor")
  expect(notion?.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(100)
})

test("registered plugin glyph replacement is reactive and stale disposal preserves its replacement", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const [name, setName] = createSignal("square-terminal")
  disposers.push(
    render(
      () =>
        createComponent(Icon, {
          get name() {
            return name()
          },
        }),
      root,
    ),
  )
  expect(root.querySelector(".lucide-square-terminal")).not.toBeNull()
  const first = registerIcon({ name: "test:logo", svgContent: '<svg data-logo="old"/>' })
  setName("test:logo")
  expect(root.querySelector('[data-logo="old"]')).not.toBeNull()
  const second = registerIcon({ name: "test:logo", svgContent: '<svg data-logo="new"/>' })
  first()
  expect(root.querySelector('[data-logo="new"]')).not.toBeNull()
  setName("square-terminal")
  second()
  expect(root.querySelector(".lucide-square-terminal")).not.toBeNull()
})
