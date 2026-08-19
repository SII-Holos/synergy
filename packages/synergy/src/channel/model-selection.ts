import { Provider } from "../provider/provider"

type ModelRef = {
  providerID: string
  modelID: string
}

export function resolveChannelAccountInvocation(input: { accountConfig: unknown; sessionModelOverride?: ModelRef }): {
  model?: ModelRef
  variant?: string
} {
  if (input.sessionModelOverride) {
    return { model: input.sessionModelOverride }
  }

  if (!input.accountConfig || typeof input.accountConfig !== "object") return {}
  const account = input.accountConfig as Record<string, unknown>
  if (typeof account.model !== "string") return {}

  const model = Provider.parseModel(account.model)
  if (!model.providerID || !model.modelID) return {}

  return {
    model,
    ...(typeof account.variant === "string" && account.variant ? { variant: account.variant } : {}),
  }
}

/**
 * Resolve the agent override for a channel account. GitHub channel accounts
 * may set `agent` to pick a specific agent; anything else falls back to the
 * caller-provided default.
 */
export function resolveChannelAccountAgent(accountConfig: unknown): string | undefined {
  if (!accountConfig || typeof accountConfig !== "object") return undefined
  const account = accountConfig as Record<string, unknown>
  return typeof account.agent === "string" && account.agent.trim() ? account.agent : undefined
}
