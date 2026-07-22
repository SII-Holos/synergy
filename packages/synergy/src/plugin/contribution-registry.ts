import {
  EXECUTABLE_CONTRIBUTION_KINDS,
  type PluginManifestContribution,
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

  registerPlugin(pluginId: string, manifest: PluginManifestType) {
    this.unregisterPlugin(pluginId)
    const registrations: PluginContributionRegistration[] = []
    const disposers: Array<() => void> = []
    for (const contribution of manifest.contributions) {
      const adapter = this.#adapters.get(contribution.kind)
      if (!adapter) throw new Error(`No contribution adapter registered for ${contribution.kind}`)
      const registration = { pluginId, manifest, contribution }
      adapter.validate(registration)
      const dispose = adapter.register?.(registration)
      if (dispose) disposers.push(dispose)
      registrations.push(registration)
    }
    this.#registrations.set(pluginId, registrations)
    this.#disposers.set(pluginId, disposers)
  }

  unregisterPlugin(pluginId: string) {
    for (const dispose of this.#disposers.get(pluginId) ?? []) dispose()
    this.#disposers.delete(pluginId)
    this.#registrations.delete(pluginId)
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

const kinds: PluginManifestContribution["kind"][] = [
  "operation",
  "event",
  "tool",
  "hook",
  "cli.command",
  "agent",
  "skill",
  "mcp",
  "authProvider",
  "ui.workbenchPanel",
  "ui.navigationItem",
  "ui.messageRenderer",
  "ui.composerAction",
  "ui.composerExtension",
  "ui.selectionExtension",
  "ui.textAction",
  "ui.messageSlot",
  "ui.settings",
  "ui.theme",
  "ui.icon",
  "lifecycle.upgrade",
  "lifecycle.uninstall",
]

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
      if (
        contribution.kind.startsWith("ui.") &&
        "component" in contribution &&
        contribution.component &&
        !manifest.artifacts.ui
      ) {
        throw new Error(`${contribution.kind}:${contribution.id} requires a UI artifact`)
      }
    },
  })
}
