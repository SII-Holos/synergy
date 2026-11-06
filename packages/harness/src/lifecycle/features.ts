import { FeaturePlan, FeaturePreferences, FeatureSelection, FeatureStatus } from "@ericsanchezok/synergy-util/features"
import { RuntimeContext } from "./context"
import { RuntimeReloadContributions } from "../config/reload-contributions"

export namespace Features {
  export const Status = FeatureStatus
  const state = RuntimeContext.state(() => ({
    plan: undefined as FeaturePlan | undefined,
    requested: [] as string[],
    enabled: new Set<string>(),
  }))

  export function register(input: FeaturePlan) {
    RuntimeContext.assertCompositionOpen("feature catalog")
    const current = state()
    if (current.plan) throw new Error("Feature catalog is already registered")
    const plan = FeaturePlan.parse(input)
    current.plan = plan
    current.requested = [...plan.optIn]
    for (const definition of plan.definitions) {
      if (
        plan.components.includes(definition.owner) &&
        (definition.maturity === "stable" || plan.optIn.includes(definition.id))
      )
        current.enabled.add(definition.id)
    }
    RuntimeReloadContributions.register({
      id: "features",
      async configChanged(change, context) {
        if (change.scope !== "global") return
        const previous = new Set(current.enabled)
        reload(change.config.features?.optIn ?? [])
        if (catalog().some((feature) => feature.pendingRestart)) context.restartRequired.add("features")
        if (
          plan.definitions.some(
            (feature) => feature.activation === "live" && previous.has(feature.id) !== enabled(feature.id),
          )
        )
          context.liveApplied.add("features")
      },
    })
  }

  export function enabled(id: string): boolean {
    return state().enabled.has(id)
  }

  export function selection(): FeaturePlan["selection"] {
    return structuredClone(state().plan?.selection ?? [])
  }

  export function reload(optIn: readonly string[]) {
    const current = state()
    current.requested = FeaturePreferences.parse({ optIn }).optIn
    for (const definition of current.plan?.definitions ?? []) {
      if (definition.activation !== "live") continue
      const active =
        current.plan!.components.includes(definition.owner) &&
        (definition.maturity === "stable" || optIn.includes(definition.id))
      if (active) current.enabled.add(definition.id)
      else current.enabled.delete(definition.id)
    }
  }

  export function catalog(requested: readonly string[] = state().requested): FeatureStatus[] {
    const current = state()
    return current.plan ? structuredClone(FeatureSelection.status(current.plan, requested, [...current.enabled])) : []
  }
}
