import type { Provider } from "./provider"

export namespace ProviderSessionHeader {
  // OpenCode Go managed inference errors on requests without a stable
  // per-conversation id since 2026-09-06
  // (https://github.com/vercel/ai/issues/20271 — AI SDK declined to send
  // provider-specific headers; the application owns the conversation id).
  const PROVIDER_IDS = new Set(["opencode-go"])
  const BASE_URL_PATTERN = /opencode\.ai\/zen\/go/

  export function headers(input: { providerID: string; baseURL?: string; sessionID?: string }): Record<string, string> {
    if (!required(input.providerID, input.baseURL)) return {}
    return { "x-opencode-session": input.sessionID ?? crypto.randomUUID() }
  }

  export function forRequest(input: {
    model: Pick<Provider.Model, "providerID" | "api" | "headers">
    sessionID?: string
  }): Record<string, string> {
    return {
      ...headers({
        providerID: input.model.providerID,
        baseURL: input.model.api.url,
        sessionID: input.sessionID,
      }),
      ...(input.model.headers ?? {}),
    }
  }

  function required(providerID: string, baseURL?: string) {
    return PROVIDER_IDS.has(providerID) || Boolean(baseURL && BASE_URL_PATTERN.test(baseURL))
  }
}
