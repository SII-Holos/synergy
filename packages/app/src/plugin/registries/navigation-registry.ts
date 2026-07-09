import type { Component } from "solid-js"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { SurfaceRegistry } from "@/surface/registry"
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
  component?: Component<NavigationContentProps>
  loader?: () => Promise<{ default: Component<NavigationContentProps> }>
  exportName?: string
}

const registry = new SurfaceRegistry<NavigationEntry>()

export function registerNavigation(entry: NavigationEntry): () => void {
  return registry.register(entry)
}

export function listNavigation(placement?: NavigationPlacement): NavigationEntry[] {
  if (placement) return registry.list((e) => e.placement === placement)
  return registry.list()
}

export function getNavigation(id: string): NavigationEntry | undefined {
  return registry.get(id)
}

export function getPluginNavigation(pluginId: string, navigationId: string): NavigationEntry | undefined {
  return registry.get(`${pluginId}:${navigationId}`)
}

export function getBuiltinNavigation(navigationId: string): NavigationEntry | undefined {
  return registry.get(navigationId)
}

export function getNavigationByPath(path: string): NavigationEntry | undefined {
  return registry.list().find((entry) => entry.path === path)
}

export function clearNavigation(pluginId?: string): void {
  registry.clear(pluginId)
}

export function subscribeNavigation(listener: () => void): () => void {
  return registry.subscribe(listener)
}
