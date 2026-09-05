import type { Provider } from "./provider"

export namespace ProviderSessionHeader {
  // OpenCode Go managed inference errors on requests without a stable
  // per-conversation id since 2026-09-06
  // (https://github.com/vercel/ai/issues/20271 — AI SDK declined to send
  // provider-specific headers; the application owns the conversation id).
  const SESSION_HEADER = "x-opencode-session"
  const PROVIDER_IDS = new Set(["opencode-go"])
  const HOST = "opencode.ai"
  const GO_PATH = /^\/zen\/go(\/|$)/

  type RequestModel = Pick<Provider.Model, "providerID" | "api" | "headers"> & {
    options?: Record<string, unknown>
  }

  export function headers(input: { providerID: string; baseURL?: string; sessionID?: string }): Record<string, string> {
    if (!required(input.providerID, input.baseURL)) return {}
    return { [SESSION_HEADER]: input.sessionID ?? crypto.randomUUID() }
  }

  export function forRequest(input: {
    model: RequestModel
    providerOptions?: { baseURL?: unknown }
    sessionID?: string
  }): Record<string, string> {
    if (pinned(input.model.headers)) return { ...input.model.headers }
    return {
      ...headers({
        providerID: input.model.providerID,
        baseURL: resolvedBaseURL(input.model, input.providerOptions),
        sessionID: input.sessionID,
      }),
      ...(input.model.headers ?? {}),
    }
  }

  // Mirror createSDKFromSpec precedence: model options beat provider options,
  // and the catalog api URL is only the fallback.
  function resolvedBaseURL(
    model: Pick<RequestModel, "api" | "options">,
    providerOptions?: { baseURL?: unknown },
  ): string | undefined {
    const fromModel = typeof model.options?.baseURL === "string" ? model.options.baseURL : undefined
    const fromProvider = typeof providerOptions?.baseURL === "string" ? providerOptions.baseURL : undefined
    return fromModel ?? fromProvider ?? model.api.url
  }

  // Any casing of the pinned header replaces the generated value; never emit
  // both, because HTTP folds duplicate names into one joined value.
  function pinned(headers?: Record<string, string>) {
    return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === SESSION_HEADER)
  }

  // The endpoint is the disclosure boundary: parse the URL and compare host
  // and path exactly, so lookalike hosts (notopencode.ai) or endpoint text in
  // a query string never receive the session id, and an override that moves
  // requests away from OpenCode Go stops the disclosure. The explicit
  // provider-id match only applies when no endpoint is known.
  function required(providerID: string, baseURL?: string) {
    if (baseURL === undefined) return PROVIDER_IDS.has(providerID)
    try {
      const url = new URL(baseURL)
      return url.hostname.toLowerCase() === HOST && GO_PATH.test(url.pathname)
    } catch {
      return false
    }
  }
}
