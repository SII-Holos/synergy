import { z } from "zod"

const Id = z.string().regex(/^[a-z][a-z0-9.-]*$/)

export const FeatureDefinition = z
  .object({
    id: Id,
    owner: Id,
    maturity: z.enum(["experimental", "stable"]),
    activation: z.enum(["live", "restart"]),
    name: z.string().min(1),
    description: z.string().min(1),
    component: Id.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.component && value.activation !== "restart")
      context.addIssue({ code: "custom", message: "Component features require restart activation" })
  })
  .meta({ ref: "FeatureDefinition" })
export type FeatureDefinition = z.infer<typeof FeatureDefinition>

export const ComponentFeatures = z
  .object({
    kind: z.enum(["foundation", "product", "bridge"]),
    definitions: z.array(FeatureDefinition),
  })
  .strict()
export type ComponentFeatures = z.infer<typeof ComponentFeatures>

export const FeaturePreferences = z
  .object({ optIn: z.array(Id).refine((ids) => new Set(ids).size === ids.length, "Duplicate experimental feature") })
  .strict()
export type FeaturePreferences = z.infer<typeof FeaturePreferences>

export interface FeatureComponent {
  readonly id: string
  readonly version: string
  readonly requires?: Readonly<Record<string, string>>
  readonly features?: { readonly kind: ComponentFeatures["kind"]; readonly definitions: readonly FeatureDefinition[] }
}

export const FeaturePlan = z
  .object({
    definitions: z.array(FeatureDefinition),
    optIn: FeaturePreferences.shape.optIn,
    selection: z.array(z.object({ id: Id, version: z.string().min(1) }).strict()),
    components: z.array(Id),
    requirements: z.record(Id, z.array(Id)),
  })
  .strict()
  .refine((plan) => {
    const active = activate(plan, plan.optIn)
    return (
      plan.components.length === active.size &&
      new Set(plan.components).size === active.size &&
      plan.components.every((id) => active.has(id))
    )
  }, "Active components do not match feature selection")
export type FeaturePlan = z.infer<typeof FeaturePlan>

export const FeatureStatus = z
  .object({
    id: Id,
    definition: FeatureDefinition.optional(),
    selected: z.boolean(),
    available: z.boolean(),
    enabled: z.boolean(),
    pendingRestart: z.boolean(),
    reason: z.enum(["not-installed", "component-unselected", "dependency-unavailable", "restart-required"]).optional(),
  })
  .meta({ ref: "FeatureStatus" })
export type FeatureStatus = z.infer<typeof FeatureStatus>

function activate(
  plan: Pick<FeaturePlan, "definitions" | "selection" | "requirements">,
  optIn: readonly string[],
): Set<string> {
  const active = new Set(plan.selection.map((component) => component.id))
  for (const definition of plan.definitions) {
    if (definition.component && definition.maturity === "experimental" && !optIn.includes(definition.id))
      active.delete(definition.component)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const id of active) {
      if (!(plan.requirements[id] ?? []).some((required) => !active.has(required))) continue
      active.delete(id)
      changed = true
    }
  }
  return active
}

export namespace FeatureSelection {
  export function complete(candidates: readonly FeatureComponent[], provided?: Readonly<Record<string, string>>) {
    return resolve(candidates, {
      provided,
      optIn: candidates.flatMap(
        (component) =>
          component.features?.definitions
            .filter((feature) => feature.maturity === "experimental")
            .map((feature) => feature.id) ?? [],
      ),
    })
  }
  export interface Options {
    optIn?: readonly string[]
    selection?: Readonly<Record<string, string>>
    provided?: Readonly<Record<string, string>>
  }

  export function resolve(candidates: readonly FeatureComponent[], options: Options = {}): FeaturePlan {
    const optIn = FeaturePreferences.parse({ optIn: options.optIn ?? [] }).optIn
    const byID = new Map<string, FeatureComponent>()
    const definitions = new Map<string, FeatureDefinition>()
    const gates = new Map<string, FeatureDefinition>()
    for (const candidate of candidates) {
      if (byID.has(candidate.id)) throw new Error(`Duplicate component: ${candidate.id}`)
      byID.set(candidate.id, candidate)
      if (!candidate.features) continue
      const metadata = ComponentFeatures.parse(candidate.features)
      if (metadata.kind === "product" && !metadata.definitions.length)
        throw new Error(`Product component ${candidate.id} needs a feature declaration`)
      for (const definition of metadata.definitions) {
        if (definition.owner !== candidate.id || (definition.component && definition.component !== candidate.id))
          throw new Error(`Feature ${definition.id} must belong to ${candidate.id}`)
        if (definitions.has(definition.id)) throw new Error(`Duplicate feature: ${definition.id}`)
        definitions.set(definition.id, definition)
        if (!definition.component) continue
        if (gates.has(definition.component)) throw new Error(`Multiple feature gates for ${definition.component}`)
        gates.set(definition.component, definition)
      }
    }
    for (const candidate of candidates) {
      if (candidate.features?.kind === "bridge" || gates.get(candidate.id)?.maturity === "experimental") continue
      const visited = new Set<string>()
      const check = (required: string) => {
        if (visited.has(required)) return
        visited.add(required)
        if (gates.get(required)?.maturity === "experimental")
          throw new Error(`Component ${candidate.id} requires experimental ${required}; split an optional integration`)
        for (const dependency of Object.keys(byID.get(required)?.requires ?? {})) check(dependency)
      }
      for (const required of Object.keys(candidate.requires ?? {})) check(required)
    }
    const available = new Set<string>()
    const include = (id: string) => {
      if (available.has(id) || options.provided?.[id]) return
      const candidate = byID.get(id)
      if (!candidate) throw new Error(`Component is not installed: ${id}`)
      available.add(id)
      if (candidate.features?.kind === "bridge") return
      for (const required of Object.keys(candidate.requires ?? {})) include(required)
    }
    for (const id of options.selection ? Object.keys(options.selection) : byID.keys()) {
      include(id)
      const version = byID.get(id)?.version ?? options.provided?.[id]
      if (options.selection && options.selection[id] !== version)
        throw new Error(`Component ${id} requires exact version ${options.selection[id]}; installed ${version}`)
    }
    const selected = candidates.filter((candidate) => available.has(candidate.id))
    const plan = {
      definitions: [...definitions.values()],
      optIn,
      selection: selected.map(({ id, version }) => ({ id, version })),
      requirements: Object.fromEntries(
        selected.map((candidate) => [
          candidate.id,
          Object.keys(candidate.requires ?? {}).filter((id) => !options.provided?.[id]),
        ]),
      ),
    }
    const active = activate(plan, optIn)
    for (const candidate of selected) {
      if (
        active.has(candidate.id) ||
        candidate.features?.kind === "bridge" ||
        gates.get(candidate.id)?.maturity === "experimental"
      )
        continue
      throw new Error(`Component ${candidate.id} requires an unavailable dependency; split an optional integration`)
    }
    return { ...plan, components: [...active] }
  }

  export function status(
    plan: FeaturePlan,
    requested: readonly string[],
    effective: readonly string[],
  ): FeatureStatus[] {
    const definitions = new Map(plan.definitions.map((definition) => [definition.id, definition]))
    const owners = new Set(plan.selection.map((component) => component.id))
    const next = activate(plan, requested)
    return [...new Set([...definitions.keys(), ...requested])].map((id) => {
      const definition = definitions.get(id)
      const selected = definition?.maturity === "stable" || requested.includes(id)
      const ownerDisabled = !!definition && !definition.component && !next.has(definition.owner)
      const dependencyUnavailable =
        !!definition && (plan.requirements[definition.owner] ?? []).some((id) => !next.has(id))
      const available = !!definition && owners.has(definition.owner) && !dependencyUnavailable && !ownerDisabled
      const enabled = !!definition && effective.includes(id)
      const nextEnabled = !!definition && next.has(definition.owner) && selected
      const pendingRestart =
        !!definition &&
        enabled !== nextEnabled &&
        (definition.activation === "restart" ||
          plan.components.includes(definition.owner) !== next.has(definition.owner))
      const reason = !definition
        ? "not-installed"
        : !owners.has(definition.owner)
          ? "component-unselected"
          : dependencyUnavailable || ownerDisabled
            ? "dependency-unavailable"
            : pendingRestart
              ? "restart-required"
              : undefined
      return { id, definition, selected, available, enabled, pendingRestart, ...(reason ? { reason } : {}) }
    })
  }
}
