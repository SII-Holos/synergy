import type { PluginStatus } from "@ericsanchezok/synergy-sdk/client"

export type InstalledPlugin = PluginStatus
export type PluginDetail = PluginStatus & { manifest?: Record<string, unknown> }
