import type { Provider } from "./provider"

export namespace PromptCachePolicy {
  export type Layout = "system" | "late-user-context"

  // DeepSeek's context cache is automatic prefix matching. It benefits from the
  // same stable-prefix layout as OpenAI-style automatic caching, but it does not
  // expose an OpenAI promptCacheKey equivalent. Do not map Synergy's sessionID to
  // DeepSeek user_id here: DeepSeek documents user_id as privacy/KVCache
  // isolation, not as an affinity key for improving hit rates.
  const LATE_USER_CONTEXT_PROVIDER_IDS = new Set(["openai", "openai-codex", "deepseek"])
  const LATE_USER_CONTEXT_SDK_PACKAGES = new Set(["@ai-sdk/openai", "@ai-sdk/azure"])
  const SESSION_CACHE_KEY_PROVIDER_IDS = new Set(["openai", "openai-codex"])
  const SESSION_CACHE_KEY_SDK_PACKAGES = new Set(["@ai-sdk/azure"])

  export function layout(model: Provider.Model): Layout {
    if (supportsLateUserContext(model)) return "late-user-context"
    return "system"
  }

  function supportsLateUserContext(model: Provider.Model) {
    return LATE_USER_CONTEXT_PROVIDER_IDS.has(model.providerID) || LATE_USER_CONTEXT_SDK_PACKAGES.has(model.api.npm)
  }

  export function usesSessionPromptCacheKey(model: Provider.Model, providerOptions?: Record<string, unknown>): boolean {
    return (
      SESSION_CACHE_KEY_PROVIDER_IDS.has(model.providerID) ||
      SESSION_CACHE_KEY_SDK_PACKAGES.has(model.api.npm) ||
      providerOptions?.setCacheKey === true
    )
  }
}
