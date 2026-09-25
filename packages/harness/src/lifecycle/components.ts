import type { RuntimeComposition, RuntimeServices } from "./runtime"
import { RuntimeContext } from "./context"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"

// Provenance: docs/decisions/implemented/architecture/2026-09-25-explicit-runtime-components.md
// Local adaptation: explicit package composition uses Runtime-owned state and separate process plugin execution.
export interface RuntimeComponent {
  readonly id: string
  readonly apiVersion: 1
  readonly version: string
  readonly requires?: Readonly<Record<string, string>>
  readonly after?: readonly string[]
  readonly configKeys?: readonly string[]
  readonly adapters?: { readonly cli?: URL; readonly http?: URL }
  readonly hosts?: readonly ("cli" | "http")[]
  readonly workers?: { readonly agent?: URL; readonly policy?: URL }
  register(): void
  services?(): RuntimeServices
}

export namespace RuntimeComponents {
  export function resolve(components: readonly RuntimeComponent[]): RuntimeComponent[] {
    const byID = new Map<string, RuntimeComponent>()
    for (const component of components) {
      if (!component.id || !component.version) throw new Error("Component identity and version are required")
      if (component.apiVersion !== 1) throw new Error(`Unsupported component API for ${component.id}`)
      if (byID.has(component.id)) throw new Error(`Duplicate component: ${component.id}`)
      byID.set(component.id, component)
    }
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

  export function compose(components: readonly RuntimeComponent[]): RuntimeComposition {
    const ordered = resolve(components)
    const state = RuntimeContext.state(() => ({
      registered: false,
      services: undefined as RuntimeServices | undefined,
    }))
    return {
      register() {
        if (state().registered) return
        RuntimeContext.assertCompositionOpen("runtime components")
        for (const component of ordered) component.register()
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
      initializeExtensions: async () => {
        for (const service of services) {
          extensions.push(service)
          await service.initializeExtensions?.()
        }
      },
      disposeExtensions: () => cleanup(extensions, (service) => service.disposeExtensions?.()),
      resident: {
        async start(config) {
          await ScopeContext.provide({
            scope: Scope.home(),
            fn: async () => {
              for (const service of services) {
                if (!service.resident) continue
                residents.push(service.resident)
                await service.resident.start(config)
              }
            },
          })
        },
        ready: (config) =>
          ScopeContext.provide({
            scope: Scope.home(),
            fn: async () => {
              for (const resident of residents) await resident.ready?.(config)
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
