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
 * Resolve the model to invoke for a channel message that carries image
 * attachments. Chat sessions stream images straight into the model; channel
 * sessions that pin a non-vision model (e.g. a default text model) would
 * otherwise degrade every attached image to a text placeholder at the provider
 * boundary. When the pinned model cannot consume images, prefer the configured
 * vision model so the image actually reaches the model, mirroring chat.
 *
 * Returns the vision model only when:
 *  - the message carries at least one image attachment, AND
 *  - the pinned model is known to lack image input capability, AND
 *  - a distinct vision model is configured and available.
 * Otherwise the pinned invocation is returned unchanged.
 */
export async function resolveChannelInvocationWithImages(input: {
  invocation: { model?: ModelRef; variant?: string }
  hasImageAttachments: boolean
}): Promise<{ model?: ModelRef; variant?: string }> {
  const { invocation, hasImageAttachments } = input
  if (!hasImageAttachments || !invocation.model) return invocation

  const pinned = await Provider.getModel(invocation.model.providerID, invocation.model.modelID).catch(() => undefined)
  if (pinned?.capabilities.input.image) return invocation

  const vision = await Provider.resolveRoleModel("vision")
  if (!vision) return invocation
  if (vision.providerID === invocation.model.providerID && vision.modelID === invocation.model.modelID) {
    return invocation
  }
  const available = await Provider.isModelAvailable(vision).catch(() => false)
  if (!available) return invocation

  return { model: vision }
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
