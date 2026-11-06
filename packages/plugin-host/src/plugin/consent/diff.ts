import type { PluginGrantContract } from "@ericsanchezok/synergy-plugin/integrity"
import { generatePermissionItems } from "./summary"
import type { PermissionItem, PluginPermissionDiff } from "./schema"

export interface DiffPermissionsState {
  oldVersion?: string
  newVersion: string
  oldCapabilities: string[]
  newCapabilities: string[]
}

export type PluginAccessChange = "equal" | "narrowed" | "broadened"

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(stable(entry))))
  if (!value || typeof value !== "object") return JSON.stringify(value)
  const sorted = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, JSON.parse(stable(entry))]),
  )
  return JSON.stringify(sorted)
}

function setRelation(before: unknown[], after: unknown[]): PluginAccessChange {
  const oldSet = new Set(before.map(stable))
  const newSet = new Set(after.map(stable))
  const added = [...newSet].some((entry) => !oldSet.has(entry))
  const removed = [...oldSet].some((entry) => !newSet.has(entry))
  if (added) return "broadened"
  return removed ? "narrowed" : "equal"
}

function combine(changes: PluginAccessChange[]): PluginAccessChange {
  if (changes.includes("broadened")) return "broadened"
  return changes.includes("narrowed") ? "narrowed" : "equal"
}

function compareConstraintValue(key: string, before: unknown, after: unknown): PluginAccessChange {
  if (stable(before) === stable(after)) return "equal"
  if (before === undefined) return "narrowed"
  if (after === undefined) return "broadened"
  if (key === "agents" || key === "modelRoles") {
    if (!Array.isArray(before) || !Array.isArray(after)) return "broadened"
    return setRelation(before, after)
  }
  if (key === "maxRuntimeMs") {
    if (typeof before !== "number" || typeof after !== "number") return "broadened"
    return after > before ? "broadened" : "narrowed"
  }
  return "broadened"
}

function compareConstraints(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): PluginAccessChange {
  if (stable(before) === stable(after)) return "equal"
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return combine([...keys].map((key) => compareConstraintValue(key, before?.[key], after?.[key])))
}

function compareCapabilities(
  before: PluginGrantContract["capabilities"],
  after: PluginGrantContract["capabilities"],
): PluginAccessChange {
  const oldById = new Map(before.map((item) => [item.id, item]))
  const newById = new Map(after.map((item) => [item.id, item]))
  if ([...newById.keys()].some((id) => !oldById.has(id))) return "broadened"
  const changes: PluginAccessChange[] = []
  for (const [id, oldCapability] of oldById) {
    const newCapability = newById.get(id)
    if (!newCapability) {
      changes.push("narrowed")
      continue
    }
    changes.push(compareConstraints(oldCapability.constraints, newCapability.constraints))
  }
  return combine(changes)
}

function compareContributionRequirements(
  before: PluginGrantContract["contributionRequirements"],
  after: PluginGrantContract["contributionRequirements"],
): PluginAccessChange {
  const identity = (item: (typeof before)[number]) => `${item.kind}:${item.id}`
  const oldById = new Map(before.map((item) => [identity(item), item]))
  const newById = new Map(after.map((item) => [identity(item), item]))
  if ([...newById.keys()].some((id) => !oldById.has(id))) return "broadened"
  const changes: PluginAccessChange[] = []
  for (const [id, oldRequirement] of oldById) {
    const newRequirement = newById.get(id)
    if (!newRequirement) {
      changes.push("narrowed")
      continue
    }
    changes.push(setRelation(oldRequirement.requires, newRequirement.requires))
    changes.push(setRelation(oldRequirement.expose ?? [], newRequirement.expose ?? []))
    if (!oldRequirement.trustedComponent && newRequirement.trustedComponent) changes.push("broadened")
    if (oldRequirement.trustedComponent && !newRequirement.trustedComponent) changes.push("narrowed")
  }
  return combine(changes)
}

export function comparePluginAccess(before: PluginGrantContract, after: PluginGrantContract): PluginAccessChange {
  return combine([
    compareCapabilities(before.capabilities, after.capabilities),
    compareContributionRequirements(before.contributionRequirements, after.contributionRequirements),
  ])
}

function contributionAccessItem(item: PluginGrantContract["contributionRequirements"][number]): PermissionItem {
  const trusted = Boolean(item.trustedComponent)
  const exposed = (item.expose?.length ?? 0) > 0
  return {
    key: `contribution:${item.kind}:${item.id}`,
    category: trusted ? "ui" : "tools",
    title: trusted
      ? "Run plugin UI in Synergy"
      : exposed
        ? "Expose a plugin operation"
        : "Use access in a plugin feature",
    description: trusted
      ? `The ${item.id} feature adds a trusted UI component.`
      : exposed
        ? `The ${item.id} operation is available to additional callers.`
        : `The ${item.id} feature uses additional declared host access.`,
    technical: `${item.kind}:${item.id}`,
  }
}

export function broadenedPermissionItems(before: PluginGrantContract, after: PluginGrantContract): PermissionItem[] {
  const changedCapabilities: string[] = []
  const oldCapabilities = new Map(before.capabilities.map((item) => [item.id, item]))
  for (const capability of after.capabilities) {
    const previous = oldCapabilities.get(capability.id)
    if (!previous || compareConstraints(previous.constraints, capability.constraints) === "broadened") {
      changedCapabilities.push(capability.id)
    }
  }

  const changedContributions: PermissionItem[] = []
  const identity = (item: PluginGrantContract["contributionRequirements"][number]) => `${item.kind}:${item.id}`
  const oldContributions = new Map(before.contributionRequirements.map((item) => [identity(item), item]))
  for (const contribution of after.contributionRequirements) {
    const previous = oldContributions.get(identity(contribution))
    if (!previous || compareContributionRequirements([previous], [contribution]) === "broadened") {
      changedContributions.push(contributionAccessItem(contribution))
    }
  }

  return [...generatePermissionItems(changedCapabilities), ...changedContributions]
}

export function diffPermissions(pluginId: string, state: DiffPermissionsState): PluginPermissionDiff {
  const { oldVersion, newVersion, oldCapabilities, newCapabilities } = state
  const oldSet = new Set(oldCapabilities)
  const newSet = new Set(newCapabilities)
  const access = generatePermissionItems(newCapabilities)
  const oldItems = new Map(generatePermissionItems(oldCapabilities).map((item) => [item.key, item]))
  const newItems = new Map(access.map((item) => [item.key, item]))
  const added = [...newSet]
    .filter((capability) => !oldSet.has(capability))
    .map((capability) => newItems.get(capability))
    .filter((item): item is PermissionItem => item !== undefined)
  const removed = [...oldSet]
    .filter((capability) => !newSet.has(capability))
    .map((capability) => oldItems.get(capability))
    .filter((item): item is PermissionItem => item !== undefined)
  const newInstall = oldVersion === undefined
  const requiresConfirmation = newInstall || added.length > 0
  return {
    pluginId,
    fromVersion: oldVersion,
    toVersion: newVersion,
    access,
    added,
    broadened: [],
    removed,
    requiresConfirmation,
    confirmationReason: requiresConfirmation ? (newInstall ? "non_official_source" : "access_expanded") : undefined,
    reason: requiresConfirmation
      ? newInstall
        ? "Confirm access for this third-party plugin."
        : "This update expands plugin access."
      : undefined,
  }
}
