import { afterAll, afterEach, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { createComponent, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { setupSolidDOM } from "../support/solid-dom"

const closeDOM = await setupSolidDOM()
afterAll(closeDOM)
const { I18nProvider } = await import("@lingui/solid")
const { SettingRow } = await import("../../src/components/setting-row")
const { TextField } = await import("../../src/components/text-field")
const i18n = setupI18n({ locale: "en", messages: { en: {} } })
const disposers: Array<() => void> = []

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

function mount(children: () => JSX.Element) {
  const root = document.createElement("div")
  document.body.append(root)
  disposers.push(
    render(
      () =>
        createComponent(I18nProvider, {
          i18n,
          get children() {
            return children()
          },
        }),
      root,
    ),
  )
  return root
}

function referencedText(element: Element, attribute: string) {
  return (element.getAttribute(attribute) ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ")
}

test("sibling settings fields inherit only their own row name and description", () => {
  const root = mount(() => [
    createComponent(SettingRow, {
      title: "Service endpoint",
      description: "Use an HTTP URL.",
      get trailing() {
        return createComponent(TextField, { value: "https://example.test" })
      },
    }),
    createComponent(SettingRow, {
      title: "Retry count",
      get trailing() {
        return createComponent(TextField, { value: "3" })
      },
    }),
    createComponent(TextField, { "aria-label": "Standalone field", value: "outside" }),
  ])
  const [endpoint, retries, standalone] = root.querySelectorAll("input")
  expect(referencedText(endpoint!, "aria-labelledby")).toBe("Service endpoint")
  expect(referencedText(endpoint!, "aria-describedby")).toBe("Use an HTTP URL.")
  expect(referencedText(retries!, "aria-labelledby")).toBe("Retry count")
  expect(referencedText(retries!, "aria-describedby")).toBe("")
  expect(standalone!.getAttribute("aria-label")).toBe("Standalone field")
  expect(standalone!.hasAttribute("aria-labelledby")).toBe(false)
  expect(standalone!.hasAttribute("aria-describedby")).toBe(false)
})

test("explicit field names override the row name while retaining row guidance and validation errors", () => {
  const root = mount(() =>
    createComponent(SettingRow, {
      title: "Connection",
      description: "Choose a reachable endpoint.",
      get trailing() {
        return createComponent(TextField, {
          "aria-label": "Fallback endpoint",
          value: "invalid",
          validationState: "invalid",
          error: "Enter an HTTP URL.",
        })
      },
    }),
  )
  const input = root.querySelector("input")!
  expect(input.getAttribute("aria-label")).toBe("Fallback endpoint")
  expect(input.hasAttribute("aria-labelledby")).toBe(false)
  expect(input.getAttribute("aria-invalid")).toBe("true")
  const description = referencedText(input, "aria-describedby")
  expect(description).toContain("Choose a reachable endpoint.")
  expect(description).toContain("Enter an HTTP URL.")
})
