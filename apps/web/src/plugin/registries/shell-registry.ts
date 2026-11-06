import type { PluginComposerLayoutService } from "@ericsanchezok/synergy-plugin"
import type { PluginConversationService } from "@ericsanchezok/synergy-plugin"
import type { Component } from "solid-js"
import type {
  PluginPageId,
  PluginShellService,
  PluginInputService,
  PluginSessionService,
  PluginSessionLayoutService,
  PluginWorkbenchService,
} from "@ericsanchezok/synergy-plugin"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"

export interface ShellRenderProps {
  shell: PluginShellService
  sessionId?: string
  input?: PluginInputService
  session?: PluginSessionService
  conversation?: PluginConversationService
  composerLayout?: PluginComposerLayoutService
  workbench?: PluginWorkbenchService
  layout?: PluginSessionLayoutService
}

export interface ShellEntry extends SlotEntryBase {
  loader: () => Promise<{ default: Component<ShellRenderProps> }>
  pages?: Partial<Record<PluginPageId, () => Promise<{ default: Component<ShellRenderProps> }>>>
}

type ShellRegistration = Omit<ShellEntry, "slot">
const registry = new SlotRegistry<ShellEntry>()

export function registerShell(entry: ShellRegistration): () => void {
  return registry.register({ ...entry, slot: "app.shell" })
}

export function listShells(): ShellEntry[] {
  return registry.list("app.shell")
}

export function getShell(id: string): ShellEntry | undefined {
  return registry.get(id)
}

export function subscribeShells(listener: () => void): () => void {
  return registry.subscribe(listener)
}
