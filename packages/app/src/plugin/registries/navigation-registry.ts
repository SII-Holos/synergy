import type { Component } from "solid-js"
import type { MessageDescriptor } from "@lingui/core"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"
import type { SurfaceEntry } from "@/surface/types"

export type NavigationPlacement = "sidebar" | "page"

export interface NavigationContentProps {
  pluginId?: string
  navigationId: string
  placement: NavigationPlacement
  scopeId?: string
}

export interface NavigationEntry extends SurfaceEntry {
  navigationId: string
  placement: NavigationPlacement
  path: string
  active?: (pathname: string) => boolean
  iconToken?: SemanticIconTokenName
  labelDescriptor?: MessageDescriptor
  component?: Component<NavigationContentProps>
  loader?: () => Promise<{ default: Component<NavigationContentProps> }>
  exportName?: string
}

/** Internal slot-backed entry: navigation items live in one slot. */
type NavigationSlotEntry = SlotEntryBase &
  NavigationEntry & {
    slot: "navigation.item"
  }

const registry = new SlotRegistry<NavigationSlotEntry>()

/** Strip the internal slot key so callers see the exact public entry shape. */
function toEntry(entry: NavigationSlotEntry): NavigationEntry {
  const { slot: _slot, ...rest } = entry
  return rest
}

export function registerNavigation(entry: NavigationEntry): () => void {
  return registry.register({ ...entry, slot: "navigation.item" })
}

export function navigationEntryLabel(
  entry: Pick<NavigationEntry, "label" | "labelDescriptor">,
  translate: (descriptor: MessageDescriptor) => string,
): string {
  return entry.labelDescriptor ? translate(entry.labelDescriptor) : entry.label
}

export function listNavigation(placement?: NavigationPlacement): NavigationEntry[] {
  if (placement) return registry.listAll((e) => e.placement === placement).map(toEntry)
  return registry.listAll().map(toEntry)
}

export function getNavigation(id: string): NavigationEntry | undefined {
  const entry = registry.get(id)
  return entry ? toEntry(entry) : undefined
}

export function getPluginNavigation(pluginId: string, navigationId: string): NavigationEntry | undefined {
  const entry = registry.get(`${pluginId}:${navigationId}`)
  return entry ? toEntry(entry) : undefined
}

export function getBuiltinNavigation(navigationId: string): NavigationEntry | undefined {
  const entry = registry.get(navigationId)
  return entry ? toEntry(entry) : undefined
}

export function getNavigationByPath(path: string): NavigationEntry | undefined {
  const entry = registry.listAll().find((item) => item.path === path)
  return entry ? toEntry(entry) : undefined
}

export function clearNavigation(pluginId?: string): void {
  registry.clear(pluginId)
}

export function subscribeNavigation(listener: () => void): () => void {
  return registry.subscribe(listener)
}
