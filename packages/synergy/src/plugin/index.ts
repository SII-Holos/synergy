import type { PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"

// Re-export the PluginManifest type for convenience
export type { PluginManifestType }

// Thinning: all previous monolithic logic lives in focused modules.
// This file is now a namespace facade that re-exports the Plugin namespace
// with identical signatures to the original index.ts.

import * as loader from "./loader"
import * as lifecycle from "./lifecycle"
import * as install from "./install"
import * as status from "./status"

export namespace Plugin {
  // Re-export LoadedPlugin type from loader
  export type LoadedPlugin = loader.LoadedPlugin
  export type DisabledPlugin = loader.DisabledPlugin

  // Loader accessors
  export const getLoaded = loader.getLoadedPlugins
  export const getDisabled = loader.getDisabledPlugins
  export const get = loader.getPlugin
  export const getDisabledPlugin = loader.getDisabledPlugin
  export const perPluginHooks = loader.getHooks
  export const allHooks = loader.getHooksList
  export const cliEntries = loader.getCliEntries
  export const skillEntries = loader.getSkillEntries
  export const agentEntries = loader.getAgentEntries
  export const lookupSpec = loader.lookupSpec

  // Lifecycle
  export const trigger = lifecycle.trigger
  export const init = lifecycle.init
  export const notifyConfigHooks = lifecycle.notifyConfigHooks
  export const reload = lifecycle.reload
  export const manifest = lifecycle.manifest

  // Install
  export const add = install.add
  export const remove = install.remove

  // Status
  export const getStatus = status.getStatus
  export const getAllStatus = status.getAllStatus
}
