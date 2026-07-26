import type { Agent } from "@/agent/agent"
import { ProviderModelVariantUnavailableError } from "@/provider/model-variant-unavailable-error"
import type { Provider } from "@/provider/provider"
import type { MessageV2 } from "./message-v2"

export namespace SessionRootVariant {
  export function resolveName(input: {
    explicit?: string
    agentDefault?: string
    roleDefault?: string
  }): string | undefined {
    return [input.explicit, input.agentDefault, input.roleDefault].find(
      (value) => value !== undefined && value.length > 0,
    )
  }

  export function resolve(input: {
    explicit?: string
    agentDefault?: string
    roleDefault?: string
    model: Provider.Model
  }): string | undefined {
    const availableVariants = Object.keys(input.model.variants ?? {})
    if (availableVariants.length === 0) return undefined
    const variant = resolveName(input)
    if (!variant) return undefined
    assertAvailable({ variant, model: input.model, availableVariants })
    return variant
  }

  export async function resolveForRoot(input: {
    explicit?: string
    agent: Agent.Info
    model?: { providerID: string; modelID: string }
  }): Promise<string | undefined> {
    const { Config } = await import("@/config/config")
    const config = await Config.current()
    const candidate = resolveName({
      explicit: input.explicit,
      agentDefault: input.agent.defaultVariant,
      roleDefault: config.role_variant?.[input.agent.modelRole || "default"],
    })
    if (!candidate || !input.model) return undefined

    const { Provider } = await import("@/provider/provider")
    return resolve({
      explicit: candidate,
      model: await Provider.getModel(input.model.providerID, input.model.modelID),
    })
  }

  export async function resolveLegacyRoot(user: MessageV2.User): Promise<string | undefined> {
    if (user.variant || user.isRoot !== true) return user.variant

    const [{ Agent }, { Config }] = await Promise.all([import("@/agent/agent"), import("@/config/config")])
    const agent = await Agent.get(user.agent).catch(() => undefined)
    if (!agent) return undefined

    const config = await Config.current()
    return resolveName({
      agentDefault: agent.defaultVariant,
      roleDefault: config.role_variant?.[agent.modelRole || "default"],
    })
  }

  export function options(input: {
    variant?: string
    model: Provider.Model
    small?: boolean
  }): Record<string, unknown> {
    if (!input.variant) return {}
    const availableVariants = Object.keys(input.model.variants ?? {})
    assertAvailable({ variant: input.variant, model: input.model, availableVariants })
    if (input.small) return {}
    return input.model.variants![input.variant]
  }

  function assertAvailable(input: { variant: string; model: Provider.Model; availableVariants: string[] }): void {
    if (Object.prototype.hasOwnProperty.call(input.model.variants ?? {}, input.variant)) return
    throw new ProviderModelVariantUnavailableError({
      providerID: input.model.providerID,
      modelID: input.model.id,
      variant: input.variant,
      availableVariants: input.availableVariants,
    })
  }
}
