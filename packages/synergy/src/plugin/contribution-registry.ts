import {
  EXECUTABLE_CONTRIBUTION_KINDS,
  hasTrustedUIComponent,
  PluginManifestContribution,
  type PluginManifestType,
} from "@ericsanchezok/synergy-plugin"

export interface PluginContributionRegistration {
  pluginId: string
  manifest: PluginManifestType
  contribution: PluginManifestContribution
}

export interface PluginContributionAdapter {
  kind: PluginManifestContribution["kind"]
  validate(registration: PluginContributionRegistration): void
  register?(registration: PluginContributionRegistration): void | (() => void)
}

export class ContributionAdapterRegistry {
  #adapters = new Map<PluginManifestContribution["kind"], PluginContributionAdapter>()
  #registrations = new Map<string, PluginContributionRegistration[]>()
  #disposers = new Map<string, Array<() => void>>()

  add(adapter: PluginContributionAdapter) {
    if (this.#adapters.has(adapter.kind)) throw new Error(`Contribution adapter already registered: ${adapter.kind}`)
    this.#adapters.set(adapter.kind, adapter)
  }

  validatePlugin(pluginId: string, manifest: PluginManifestType) {
    return manifest.contributions.map((contribution) => {
      const adapter = this.#adapters.get(contribution.kind)
      if (!adapter) throw new Error(`No contribution adapter registered for ${contribution.kind}`)
      const registration = { pluginId, manifest, contribution }
      adapter.validate(registration)
      return registration
    })
  }

  registerPlugin(pluginId: string, manifest: PluginManifestType) {
    const registrations = this.validatePlugin(pluginId, manifest)
    const previous = this.#registrations.get(pluginId)
    try {
      this.unregisterPlugin(pluginId)
      this.#install(pluginId, registrations)
    } catch (error) {
      if (previous) {
        try {
          this.#install(pluginId, previous)
        } catch (rollback) {
          throw new AggregateError([error, rollback], "Contribution registration and restoration failed")
        }
      }
      throw error
    }
  }

  #install(pluginId: string, registrations: PluginContributionRegistration[]) {
    const disposers: Array<() => void> = []
    try {
      for (const registration of registrations) {
        const dispose = this.#adapters.get(registration.contribution.kind)?.register?.(registration)
        if (dispose) disposers.push(dispose)
      }
    } catch (error) {
      const errors = [error]
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (cleanup) {
          errors.push(cleanup)
        }
      }
      if (errors.length > 1) throw new AggregateError(errors, "Contribution registration cleanup failed")
      throw error
    }
    this.#registrations.set(pluginId, registrations)
    this.#disposers.set(pluginId, disposers)
  }

  unregisterPlugin(pluginId: string) {
    const disposers = this.#disposers.get(pluginId) ?? []
    this.#disposers.delete(pluginId)
    this.#registrations.delete(pluginId)
    const errors: unknown[] = []
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "Contribution cleanup failed")
  }

  list<Kind extends PluginManifestContribution["kind"]>(pluginId: string, kind: Kind) {
    return (this.#registrations.get(pluginId) ?? [])
      .map((registration) => registration.contribution)
      .filter(
        (contribution): contribution is Extract<PluginManifestContribution, { kind: Kind }> =>
          contribution.kind === kind,
      )
  }
}

export const pluginContributionAdapters = new ContributionAdapterRegistry()

const kinds = PluginManifestContribution.options.map((schema) => schema.shape.kind.value)

for (const kind of kinds) {
  pluginContributionAdapters.add({
    kind,
    validate({ manifest, contribution }) {
      if (
        (EXECUTABLE_CONTRIBUTION_KINDS as readonly string[]).includes(contribution.kind) &&
        !manifest.artifacts.runtime
      ) {
        throw new Error(`${contribution.kind}:${contribution.id} requires a runtime artifact`)
      }
      if (hasTrustedUIComponent(contribution) && !manifest.artifacts.ui) {
        throw new Error(`${contribution.kind}:${contribution.id} requires a UI artifact`)
      }
    },
  })
}
