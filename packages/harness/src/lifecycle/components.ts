import type { RuntimeComposition, RuntimeServices } from "./runtime"
import { RuntimeContext } from "./context"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { z } from "zod"
import { FeaturePlan, FeatureSelection, type FeatureComponent } from "@ericsanchezok/synergy-util/features"
import { Features } from "./features"

// Provenance: docs/decisions/implemented/architecture/2026-09-25-explicit-runtime-components.md
// Local adaptation: explicit package composition uses Runtime-owned state and separate process plugin execution.
export interface RuntimeComponent extends FeatureComponent {
  readonly apiVersion: 1
  readonly after?: readonly string[]
  readonly configKeys?: readonly string[]
  readonly adapters?: { readonly cli?: URL; readonly http?: URL }
  readonly hosts?: readonly ("cli" | "http")[]
  readonly workers?: { readonly agent?: URL; readonly policy?: URL }
  readonly maintenance?: URL
  register(): void
  services?(): RuntimeServices
}

export namespace RuntimeComponents {
  export const Info = z
    .object({ id: z.string(), version: z.string(), apiVersion: z.literal(1) })
    .meta({ ref: "RuntimeComponentInfo" })
  const selection = RuntimeContext.state(() => new Map<string, z.infer<typeof Info>>())

  export function selected(): z.infer<typeof Info>[] {
    return [...selection().values()].map((item) => ({ ...item })).sort((a, b) => a.id.localeCompare(b.id))
  }

  export function registerSelection(components: readonly z.infer<typeof Info>[]) {
    RuntimeContext.assertCompositionOpen("runtime component selection")
    const entries = z.array(Info.strict()).parse(components)
    const ids = new Set<string>()
    for (const entry of entries) {
      if (!entry.id || !entry.version) throw new Error("Component identity and version are required")
      if (ids.has(entry.id) || selection().has(entry.id)) throw new Error(`Duplicate component: ${entry.id}`)
      ids.add(entry.id)
    }
    for (const entry of entries) selection().set(entry.id, Object.freeze(entry))
  }

  export function resolve(candidates: readonly RuntimeComponent[], features?: FeaturePlan): RuntimeComponent[] {
    const byID = new Map<string, RuntimeComponent>()
    for (const component of candidates) {
      if (!component.id || !component.version) throw new Error("Component identity and version are required")
      if (component.apiVersion !== 1) throw new Error(`Unsupported component API for ${component.id}`)
      if (byID.has(component.id)) throw new Error(`Duplicate component: ${component.id}`)
      byID.set(component.id, component)
    }
    if (features) {
      const versions = new Map(features.selection.map(({ id, version }) => [id, version]))
      for (const id of features.components) {
        const component = byID.get(id)
        if (!component) throw new Error(`Feature plan requires missing component: ${id}`)
        if (component.version !== versions.get(id))
          throw new Error(`Component ${id} version does not match its feature plan`)
      }
      for (const id of byID.keys()) if (!features.components.includes(id)) byID.delete(id)
    }
    const components = [...byID.values()]
    for (const component of components) {
      for (const [id, range] of Object.entries(component.requires ?? {})) {
        const dependency = byID.get(id)
        if (!dependency) throw new Error(`Component ${component.id} requires ${id}@${range}`)
        if (dependency.version !== "local" && !Bun.semver.satisfies(dependency.version, range))
          throw new Error(`Component ${component.id} requires ${id}@${range}; ${dependency.version} is incompatible`)
      }
    }
    const ordered: RuntimeComponent[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    function visit(component: RuntimeComponent) {
      if (visited.has(component.id)) return
      if (visiting.has(component.id)) throw new Error(`Component dependency cycle at ${component.id}`)
      visiting.add(component.id)
      const predecessors = new Set([...Object.keys(component.requires ?? {}), ...(component.after ?? [])])
      for (const id of [...predecessors].sort()) {
        const predecessor = byID.get(id)
        if (predecessor) visit(predecessor)
      }
      visiting.delete(component.id)
      visited.add(component.id)
      ordered.push(component)
    }
    for (const component of [...components].sort((a, b) => a.id.localeCompare(b.id))) visit(component)
    return ordered
  }

  export function compose(
    components: readonly RuntimeComponent[],
    features = FeatureSelection.resolve(components),
  ): RuntimeComposition {
    const plan = FeaturePlan.parse(features)
    const ordered = resolve(components, plan)
    const state = RuntimeContext.state(() => ({
      registered: false,
      services: undefined as RuntimeServices | undefined,
    }))
    return {
      register() {
        if (state().registered) return
        RuntimeContext.assertCompositionOpen("runtime components")
        Features.register(plan)
        for (const component of ordered) component.register()
        registerSelection(ordered.map(({ id, version, apiVersion }) => ({ id, version, apiVersion })))
        state().registered = true
      },
      services() {
        const current = state()
        if (!current.registered) throw new Error("Register components before opening their services")
        current.services ??= composeServices(
          ordered.map((component) => ({ id: component.id, ...component.services?.() })),
        )
        return current.services
      },
    }
  }

  function composeServices(services: Array<RuntimeServices & { id: string }>): RuntimeServices {
    const transports = services.filter((service) => service.transport)
    if (transports.length > 1)
      throw new Error(`Multiple transport components: ${transports.map((service) => service.id).join(", ")}`)
    const schemas = new Set(services.flatMap((service) => (service.configSchemaPath ? [service.configSchemaPath] : [])))
    if (schemas.size > 1) throw new Error("Multiple component configuration schema paths")
    const extensions: RuntimeServices[] = []
    const residents: NonNullable<RuntimeServices["resident"]>[] = []
    const reloaders: NonNullable<RuntimeServices["reload"]>[] = []
    async function cleanup<T>(active: T[], dispose: (item: T) => Promise<unknown> | unknown) {
      const errors: unknown[] = []
      for (const item of active.splice(0).reverse()) {
        try {
          await dispose(item)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Component resource cleanup failed")
    }
    return {
      configSchemaPath: schemas.values().next().value,
      transport: transports[0]?.transport,
      initializeExtensions: async (progress) => {
        for (const service of services) {
          extensions.push(service)
          if (!service.initializeExtensions) continue
          await service.initializeExtensions(progress)
          progress?.()
        }
      },
      disposeExtensions: () => cleanup(extensions, (service) => service.disposeExtensions?.()),
      async started(progress) {
        for (const service of services) {
          if (!service.started) continue
          await service.started(progress)
          progress?.()
        }
      },
      resident: {
        async start(config, progress) {
          await ScopeContext.provide({
            scope: Scope.home(),
            fn: async () => {
              for (const service of services) {
                if (!service.resident) continue
                residents.push(service.resident)
                await service.resident.start(config, progress)
                progress?.()
              }
            },
          })
        },
        ready: (config, progress) =>
          ScopeContext.provide({
            scope: Scope.home(),
            fn: async () => {
              for (const resident of residents) {
                if (!resident.ready) continue
                await resident.ready(config, progress)
                progress?.()
              }
            },
          }),
        stop: () =>
          ScopeContext.provide({ scope: Scope.home(), fn: () => cleanup(residents, (resident) => resident.stop()) }),
      },
      reload: {
        start() {
          for (const service of services) {
            if (!service.reload) continue
            reloaders.push(service.reload)
            service.reload.start()
          }
        },
        stop: () => cleanup(reloaders, (reloader) => reloader.stop()),
      },
    }
  }
}
