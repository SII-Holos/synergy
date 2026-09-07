import { afterEach, expect, test } from "bun:test"
import { Button, Icon, PLUGIN_UI_RUNTIME_KEY, type PluginUIComponents } from "../src/components"
import { SemanticIconToken } from "../src/icons"

const runtime = globalThis as typeof globalThis & { [PLUGIN_UI_RUNTIME_KEY]?: PluginUIComponents }
const original = runtime[PLUGIN_UI_RUNTIME_KEY]
afterEach(() => {
  if (original) runtime[PLUGIN_UI_RUNTIME_KEY] = original
  else delete runtime[PLUGIN_UI_RUNTIME_KEY]
})

test("public components require the current host runtime and preserve reactive props", () => {
  delete runtime[PLUGIN_UI_RUNTIME_KEY]
  expect(() => Button({ children: "Send" })).toThrow("UI API 5 host")
  let label = "Send"
  const props = {
    get children() {
      return label
    },
  }
  let received: unknown
  const host = new Proxy({} as PluginUIComponents, {
    get(_target, name) {
      if (name === "Icon") return (value: { token: keyof typeof SemanticIconToken }) => SemanticIconToken[value.token]
      return (value: typeof props) => {
        received = value
        return value.children
      }
    },
  })
  runtime[PLUGIN_UI_RUNTIME_KEY] = host
  expect(Button(props)).toBe("Send")
  expect(received).toBe(props)
  label = "Cancel"
  expect(Button(props)).toBe("Cancel")
  expect(Icon({ token: "plugins.main" })).toBe(SemanticIconToken["plugins.main"])
  delete runtime[PLUGIN_UI_RUNTIME_KEY]
  expect(() => Button(props)).toThrow("runtime is unavailable")
})
