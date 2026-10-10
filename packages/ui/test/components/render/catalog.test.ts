import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { RenderUI } from "@ericsanchezok/synergy-util/render-ui"
import { installRenderCatalog } from "../../../src/components/render/catalog"

test("the native catalog paints safe keyed content, retains focus and dispatches only declared interactions", () => {
  const dom = new JSDOM('<div id="root"></div>')
  const root = dom.window.document.getElementById("root")!
  const catalog = installRenderCatalog(root, RenderUI.evaluate)
  const spec = RenderUI.Spec.parse({
    state: { seats: 8, plan: "Team", enabled: true },
    computed: [{ id: "price", op: "multiply", inputs: [{ ref: "seats" }, 29] }],
    nodes: [
      { id: "title", type: "heading", text: "Team estimate" },
      { id: "row", type: "row", columns: 2 },
      { id: "card", type: "card", parent: "row", title: "Current plan" },
      { id: "seats", type: "slider", parent: "card", label: "Seats", state: "seats", min: 1, max: 50 },
      { id: "plan", type: "select", parent: "card", label: "Plan", state: "plan", options: ["Team", "Pro"] },
      { id: "enabled", type: "checkbox", parent: "card", label: "Enabled", state: "enabled" },
      { id: "price", type: "metric", parent: "row", label: "Price", value: { ref: "price" }, prefix: "$" },
      {
        id: "bars",
        type: "bar",
        label: "Price comparison",
        items: [
          { label: "Current", value: { ref: "price" } },
          { label: "Base", value: 29 },
        ],
      },
      { id: "untrusted", type: "text", text: '<img src="https://example.com" onerror="alert(1)">' },
      { id: "next", type: "button", label: "Review", text: "Review this estimate" },
    ],
  })
  let state = spec.state
  const requests: string[] = []
  const options = {
    locale: "en",
    disabled: false,
    change(key: string, value: RenderUI.Value) {
      state = { ...state, [key]: value }
      catalog.update(spec, state, options)
    },
    followUp(text: string) {
      requests.push(text)
    },
  }
  catalog.update(spec, state, options)
  expect(root.querySelector("img")).toBeNull()
  expect(root.textContent).toContain('<img src="https://example.com"')
  expect(root.querySelector('[data-render-node="price"] output')!.textContent).toBe("$232")
  const slider = root.querySelector<HTMLInputElement>('input[type="range"]')!
  slider.focus()
  slider.value = "9"
  slider.dispatchEvent(new dom.window.Event("input"))
  expect(root.querySelector('input[type="range"]')).toBe(slider)
  expect(dom.window.document.activeElement).toBe(slider)
  expect(root.querySelector('[data-render-node="price"] output')!.textContent).toBe("$261")
  const select = root.querySelector("select")!
  select.value = "Pro"
  select.dispatchEvent(new dom.window.Event("input"))
  const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  checkbox.checked = false
  checkbox.dispatchEvent(new dom.window.Event("input"))
  root.querySelector("button")!.click()
  expect(requests[0]).toContain('"plan":"Pro"')
  expect(requests[0]).toContain('"enabled":false')
  expect(root.querySelector("meter")!.value).toBe(261)
  catalog.update(spec, state, { ...options, disabled: true })
  expect(slider.disabled).toBe(true)
  catalog.dispose()
  expect(root.childElementCount).toBe(0)
  dom.window.close()
})
