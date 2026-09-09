import type { Provider } from "./provider"

export namespace PromptCachePolicy {
  export type Layout = "system" | "late-user-context"

  // DeepSeek's context cache is automatic prefix matching. It benefits from the
  // same stable-prefix layout as OpenAI-style automatic caching, but it does not
  // expose an OpenAI promptCacheKey equivalent. Do not map Synergy's sessionID to
  // DeepSeek user_id here: DeepSeek documents user_id as privacy/KVCache
  // isolation, not as an affinity key for improving hit rates.
  // Every @ai-sdk/openai-compatible transport gets the late-user-context
  // layout: the mainstream providers behind that SDK (DeepSeek, Zhipu GLM,
  // Alibaba Qwen, Moonshot, and OpenAI-compatible gateways) all implement
  // automatic prefix caching without explicit cache-control parameters, so
  // volatile advisory context must sit after the append-only history prefix.
  // Providers behind it that lack prefix caching only lose the stricter
  // system-message ordering, never correctness.
  const LATE_USER_CONTEXT_PROVIDER_IDS = new Set(["openai", "openai-codex", "deepseek", "anthropic"])
  const LATE_USER_CONTEXT_SDK_PACKAGES = new Set(["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/openai-compatible"])
  const SESSION_CACHE_KEY_PROVIDER_IDS = new Set(["openai", "openai-codex"])
  const SESSION_CACHE_KEY_SDK_PACKAGES = new Set(["@ai-sdk/azure"])

  export function layout(model: Provider.Model, profileID?: string): Layout {
    if (supportsLateUserContext(model, profileID)) return "late-user-context"
    return "system"
  }

  function supportsLateUserContext(model: Provider.Model, profileID?: string) {
    return (
      LATE_USER_CONTEXT_PROVIDER_IDS.has(profileID ?? model.providerID) ||
      LATE_USER_CONTEXT_SDK_PACKAGES.has(model.api.npm)
    )
  }

  export function usesSessionPromptCacheKey(
    model: Provider.Model,
    providerOptions?: Record<string, unknown>,
    profileID?: string,
  ): boolean {
    return (
      SESSION_CACHE_KEY_PROVIDER_IDS.has(profileID ?? model.providerID) ||
      SESSION_CACHE_KEY_SDK_PACKAGES.has(model.api.npm) ||
      providerOptions?.setCacheKey === true
    )
  }
}
