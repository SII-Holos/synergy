import { expect, test } from "bun:test"
import { providerAuthMethodLabel } from "../../../src/components/provider/provider-auth-method-label"

test("localizes the canonical Codex methods and preserves custom labels", () => {
  expect(providerAuthMethodLabel("openai-codex", { type: "oauth", label: "Login with ChatGPT" })?.id).toBe(
    "settings.providers.method.chatgpt",
  )
  expect(providerAuthMethodLabel("openai-codex", { type: "import", label: "Import Codex CLI credentials" })?.id).toBe(
    "settings.providers.method.codexImport",
  )
  expect(providerAuthMethodLabel("plugin-service", { type: "oauth", label: "Login with ChatGPT" })).toBeUndefined()
  expect(providerAuthMethodLabel("openai-codex", { type: "oauth", label: "Company single sign-on" })).toBeUndefined()
})
