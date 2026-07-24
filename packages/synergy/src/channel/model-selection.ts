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
