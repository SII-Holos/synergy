import type { ProviderAuthMethod } from "@ericsanchezok/synergy-sdk/client"

export function providerAuthMethodLabel(profileID: string, method: ProviderAuthMethod) {
  if (profileID === "openai-codex") {
    if (method.type === "oauth" && method.label === "Login with ChatGPT")
      return { id: "settings.providers.method.chatgpt", message: "Sign in with ChatGPT" }
    if (method.type === "import" && method.label === "Import Codex CLI credentials")
      return { id: "settings.providers.method.codexImport", message: "Use Codex CLI sign-in on this device" }
  }
  if (profileID === "anthropic") {
    if (method.type === "oauth" && method.label === "Login with Claude Pro/Max")
      return { id: "settings.providers.method.claude", message: "Sign in with Claude Pro/Max" }
    if (method.type === "api" && method.label === "API key")
      return { id: "settings.providers.method.apiKey", message: "Use an API key" }
  }
  if (profileID === "grok" && method.type === "oauth" && method.label === "Login with Grok")
    return { id: "settings.providers.method.grok", message: "Sign in with Grok" }
  if (profileID === "minimax" && method.type === "oauth" && method.label === "Login with MiniMax")
    return { id: "settings.providers.method.minimax", message: "Sign in with MiniMax" }
  if (["github", "github-copilot", "github-copilot-enterprise"].includes(profileID)) {
    if (method.type === "api" && method.label === "GitHub token")
      return { id: "settings.providers.method.githubToken", message: "Use a GitHub token" }
    if (method.type === "oauth" && method.label === "Sign in with GitHub")
      return { id: "settings.providers.method.github", message: "Sign in with GitHub" }
    if (method.type === "oauth" && method.label === "Login with GitHub Copilot")
      return { id: "settings.providers.method.copilot", message: "Sign in with GitHub Copilot" }
    if (method.type === "oauth" && method.label === "Login with GitHub Copilot Enterprise")
      return { id: "settings.providers.method.copilotEnterprise", message: "Sign in with GitHub Copilot Enterprise" }
  }
}
