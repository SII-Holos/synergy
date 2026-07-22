import type { PluginCapability } from "./capability.js"
import {
  contributionHandlerId,
  schemaToJsonSchema,
  type PluginContribution,
  type TrustedComponentReference,
} from "./contribution.js"
import type { PluginActivationContext } from "./context.js"
import type { PluginManifest, PluginManifestContribution } from "./manifest.js"
import { PLUGIN_API_VERSION, PLUGIN_MANIFEST_VERSION } from "./version.js"

export interface PluginDefinitionInput {
  id: string
  name?: string
  version: string
  description: string
  author?: string
  homepage?: string
  repository?: string
  license?: string
  icon?: string
  keywords?: string[]
  assets?: PluginAsset[]
  capabilities?: PluginCapability[]
  contributions: PluginContribution[]
  activate?(context: PluginActivationContext): Promise<void>
  deactivate?(): Promise<void>
}

export interface PluginAsset {
  source: string
  target: string
}

export interface PluginDefinition extends PluginDefinitionInput {
  assets: PluginAsset[]
  capabilities: PluginCapability[]
  handlerIds: string[]
}

export interface CompiledPluginArtifacts {
  generation: string
  runtime?: { entry: string; sha256: string }
  ui?: { entry: string; sha256: string; exports?: Record<string, string> }
}

function validateId(id: string, label: string) {
  const pattern =
    label === "plugin capability"
      ? /^[a-z][A-Za-z0-9.-]*$/
      : label === "plugin contribution id"
        ? /^[a-z][A-Za-z0-9._-]*$/
        : /^[a-z][a-z0-9.-]*$/
  if (!pattern.test(id)) throw new Error(`Invalid ${label} "${id}"`)
}

export function definePlugin(input: PluginDefinitionInput): PluginDefinition {
  validateId(input.id, "plugin id")
  const assets = input.assets ?? []
  const assetTargets = new Set<string>()
  for (const asset of assets) {
    if (!asset.source.trim()) throw new Error("Plugin asset source cannot be empty")
    if (!asset.target.trim()) throw new Error("Plugin asset target cannot be empty")
    const target = asset.target.replace(/\\/g, "/").replace(/^\.\//, "")
    if (assetTargets.has(target)) throw new Error(`Duplicate plugin asset target "${target}"`)
    assetTargets.add(target)
  }
  const capabilities = input.capabilities ?? []
  const capabilityIds = new Set<string>()
  for (const item of capabilities) {
    validateId(item.id, "plugin capability")
    if (capabilityIds.has(item.id)) throw new Error(`Duplicate plugin capability "${item.id}"`)
    capabilityIds.add(item.id)
  }

  const contributionIds = new Set<string>()
  const handlerIds: string[] = []
  for (const contribution of input.contributions) {
    validateId(contribution.id, "plugin contribution id")
    if (contributionIds.has(contribution.id)) {
      throw new Error(`Duplicate plugin contribution id "${contribution.id}"`)
    }
    contributionIds.add(contribution.id)
    for (const required of contribution.requires ?? []) {
      if (!capabilityIds.has(required)) {
        throw new Error(`Contribution "${contribution.id}" requires undeclared capability "${required}"`)
      }
    }
    const handlerId = contributionHandlerId(contribution)
    if (handlerId) handlerIds.push(handlerId)
    if (contribution.kind === "hook" && contribution.point === "session.user-message.after") {
      if (!contribution.requires?.includes("session.read")) {
        throw new Error(`Hook contribution "${contribution.id}" requires session.read`)
      }
    }
    if (
      (contribution.kind === "ui.selectionExtension" || contribution.kind === "ui.textAction") &&
      !contribution.requires?.includes("selection.read")
    ) {
      throw new Error(`Contribution "${contribution.id}" requires selection.read`)
    }
  }

  for (const contribution of input.contributions) {
    if (contribution.kind !== "ui.textAction") continue
    const operation = input.contributions.find(
      (item) => item.kind === "operation" && item.id === contribution.operation,
    )
    if (
      !operation ||
      operation.kind !== "operation" ||
      operation.type !== "command" ||
      !operation.expose.includes("ui")
    ) {
      throw new Error(`Text action "${contribution.id}" must reference a UI-exposed command operation`)
    }
  }

  const settings = input.contributions.find((item) => item.kind === "ui.settings")
  const properties =
    settings?.formSchema && typeof settings.formSchema.properties === "object" && settings.formSchema.properties
      ? (settings.formSchema.properties as Record<string, unknown>)
      : {}
  for (const contribution of input.contributions) {
    if (contribution.kind === "tool" && contribution.enabledWhen && !(contribution.enabledWhen.setting in properties)) {
      throw new Error(
        `Tool contribution "${contribution.id}" references undeclared setting "${contribution.enabledWhen.setting}"`,
      )
    }
  }

  return { ...input, assets, capabilities, handlerIds }
}

function compiledComponent(
  component: TrustedComponentReference | undefined,
  artifacts: CompiledPluginArtifacts,
  contributionKey: string,
): { entry: string; exportName: string } | undefined {
  if (!component) return undefined
  if (!artifacts.ui) throw new Error("Plugin declares trusted UI components but no UI artifact was built")
  return {
    entry: artifacts.ui.entry,
    exportName: artifacts.ui.exports?.[contributionKey] ?? component.exportName ?? "default",
  }
}

function compileContribution(
  contribution: PluginContribution,
  artifacts: CompiledPluginArtifacts,
): PluginManifestContribution {
  const base = {
    id: contribution.id,
    ...(contribution.requires?.length ? { requires: contribution.requires } : {}),
  }

  switch (contribution.kind) {
    case "operation":
      return {
        ...base,
        kind: "operation",
        type: contribution.type,
        expose: contribution.expose,
        input: schemaToJsonSchema(contribution.input),
        output: schemaToJsonSchema(contribution.output),
        ...(contribution.timeoutMs ? { timeoutMs: contribution.timeoutMs } : {}),
      }
    case "event":
      return { ...base, kind: "event", payload: schemaToJsonSchema(contribution.payload) }
    case "tool":
      return {
        ...base,
        kind: "tool",
        description: contribution.description,
        input: schemaToJsonSchema(contribution.input),
        ...(contribution.exposure ? { exposure: contribution.exposure } : {}),
        ...(contribution.display ? { display: contribution.display as unknown as Record<string, unknown> } : {}),
        ...(contribution.enabledWhen ? { enabledWhen: contribution.enabledWhen } : {}),
      }
    case "cli.command":
      return {
        ...base,
        kind: "cli.command",
        description: contribution.description,
        options: contribution.options,
        ...(contribution.timeoutMs ? { timeoutMs: contribution.timeoutMs } : {}),
      }
    case "hook":
      return { ...base, kind: "hook", point: contribution.point, priority: contribution.priority }
    case "agent":
      return { ...base, kind: "agent", agent: contribution.agent as unknown as Record<string, unknown> }
    case "skill":
      return { ...base, kind: "skill", skill: contribution.skill as unknown as Record<string, unknown> }
    case "mcp":
      return { ...base, kind: "mcp", server: contribution.server }
    case "authProvider": {
      return {
        ...base,
        kind: "authProvider",
        provider: contribution.profile,
      }
    }
    case "ui.workbenchPanel":
      return {
        ...base,
        kind: "ui.workbenchPanel",
        label: contribution.label,
        icon: contribution.icon,
        order: contribution.order,
        surface: contribution.surface,
        cardinality: contribution.cardinality,
        requiresSession: contribution.requiresSession,
        defaultResource: contribution.defaultResource,
        component: compiledComponent(contribution.component, artifacts, `${contribution.kind}:${contribution.id}`),
      }
    case "ui.navigationItem":
      return {
        ...base,
        kind: "ui.navigationItem",
        label: contribution.label,
        icon: contribution.icon,
        order: contribution.order,
        placement: contribution.placement,
        component: compiledComponent(contribution.component, artifacts, `${contribution.kind}:${contribution.id}`),
      }
    case "ui.messageRenderer":
      return {
        ...base,
        kind: "ui.messageRenderer",
        label: contribution.label,
        icon: contribution.icon,
        order: contribution.order,
        messageType: contribution.messageType,
        component: compiledComponent(contribution.component, artifacts, `${contribution.kind}:${contribution.id}`),
      }
    case "ui.composerAction":
      return {
        ...base,
        kind: "ui.composerAction",
        label: contribution.label,
        icon: contribution.icon,
        order: contribution.order,
        slot: contribution.slot,
        component: compiledComponent(contribution.component, artifacts, `${contribution.kind}:${contribution.id}`),
      }
    case "ui.composerExtension":
    case "ui.selectionExtension":
      return {
        ...base,
        kind: contribution.kind,
        order: contribution.order,
        component: compiledComponent(contribution.component, artifacts, `${contribution.kind}:${contribution.id}`)!,
      }
    case "ui.textAction":
      return {
        ...base,
        kind: "ui.textAction",
        label: contribution.label,
        icon: contribution.icon,
        order: contribution.order,
        operation: contribution.operation,
      }
    case "ui.messageSlot":
      return {
        ...base,
        kind: "ui.messageSlot",
        order: contribution.order,
        slot: contribution.slot,
        roles: contribution.roles,
        component: compiledComponent(contribution.component, artifacts, `${contribution.kind}:${contribution.id}`)!,
      }
    case "ui.settings":
      return {
        ...base,
        kind: "ui.settings",
        label: contribution.label,
        icon: contribution.icon,
        order: contribution.order,
        group: contribution.group,
        formSchema: contribution.formSchema,
        visibility: contribution.visibility,
        component: compiledComponent(contribution.component, artifacts, `${contribution.kind}:${contribution.id}`),
      }
    case "ui.theme":
      return { ...base, kind: "ui.theme", label: contribution.label, path: contribution.path }
    case "ui.icon":
      return { ...base, kind: "ui.icon", path: contribution.path }
    case "lifecycle.upgrade":
      return { ...base, kind: "lifecycle.upgrade" }
    case "lifecycle.uninstall":
      return { ...base, kind: "lifecycle.uninstall" }
  }
}

export function compilePluginManifest(
  definition: PluginDefinition,
  artifacts: CompiledPluginArtifacts,
): PluginManifest {
  const manifest: PluginManifest = {
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    id: definition.id,
    name: definition.name ?? definition.id,
    version: definition.version,
    description: definition.description,
    ...(definition.author ? { author: definition.author } : {}),
    ...(definition.homepage ? { homepage: definition.homepage } : {}),
    ...(definition.repository ? { repository: definition.repository } : {}),
    ...(definition.license ? { license: definition.license } : {}),
    ...(definition.icon ? { icon: definition.icon } : {}),
    ...(definition.keywords ? { keywords: definition.keywords } : {}),
    capabilities: definition.capabilities,
    contributions: definition.contributions.map((item) => compileContribution(item, artifacts)),
    artifacts: {
      generation: artifacts.generation,
      ...(artifacts.runtime ? { runtime: artifacts.runtime } : {}),
      ...(artifacts.ui ? { ui: { entry: artifacts.ui.entry, sha256: artifacts.ui.sha256 } } : {}),
    },
  }
  return manifest
}
