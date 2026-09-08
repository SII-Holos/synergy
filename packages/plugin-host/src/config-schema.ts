import path from "node:path"
import { PluginSpec } from "@ericsanchezok/synergy-harness/util/plugin-spec"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import z from "zod"
import { DEFAULT_PLUGIN_MARKETPLACE_CONFIG } from "@ericsanchezok/synergy-plugin/market"
import { DEFAULT_PLUGIN_RUNTIME_LIMITS } from "@ericsanchezok/synergy-util/plugin-policy"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const PluginRuntimeLimits = z
  .object({
    startupTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum milliseconds for plugin runtime startup"),
    toolInvocationTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum milliseconds for a plugin tool invocation"),
    hostServiceRequestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum milliseconds for one plugin Host Service request"),
    taskRunTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Default maximum milliseconds for plugin delegated task runs"),
    shutdownGraceMs: z.number().int().positive().optional().describe("Graceful shutdown window before force kill"),
    heartbeatIntervalMs: z.number().int().positive().optional().describe("Heartbeat interval in milliseconds"),
    maxMemoryMb: z.number().int().positive().optional().describe("External plugin runtime RSS limit in megabytes"),
    memorySampleIntervalMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("External plugin runtime RSS sampling interval in milliseconds"),
    agentCallMaxRuntimeMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum milliseconds for a plugin agent.call/agent.start model invocation"),
    hookTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum milliseconds for one plugin hook handler invocation"),
    contributionInvokeTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Default maximum milliseconds for a plugin contribution invocation without a declared timeout"),
    shellRunTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Default maximum milliseconds for plugin shell.run commands"),
    taskRunWaitTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum milliseconds a plugin task.run waits for a delegated task to reach a terminal state"),
  })
  .strict()
  .meta({ ref: "PluginRuntimeLimitsConfig" })

export type PluginRuntimeLimits = z.infer<typeof PluginRuntimeLimits>

export const PluginRuntimePolicy = z
  .object({
    limits: PluginRuntimeLimits.optional()
      .default(DEFAULT_PLUGIN_RUNTIME_LIMITS)
      .describe("Default plugin runtime resource and request limits"),
  })
  .strict()
  .meta({ ref: "PluginRuntimePolicyConfig" })

export type PluginRuntimePolicy = z.infer<typeof PluginRuntimePolicy>

export const PLUGIN_RUNTIME_POLICY_DEFAULTS = {
  limits: DEFAULT_PLUGIN_RUNTIME_LIMITS,
} as const satisfies Required<PluginRuntimePolicy>

export const PluginMarketplace = z
  .object({
    enabled: z.boolean().optional().default(true).describe("Enable the public GitHub-backed plugin marketplace"),
    registryUrl: z
      .string()
      .url()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.registryUrl)
      .describe("URL of the official plugin registry.json index"),
    includeLocalRegistry: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include the local development registry in marketplace search and detail routes"),
    cacheTtlMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.cacheTtlMs)
      .describe("Remote marketplace cache TTL in milliseconds"),
    offlineCache: z
      .boolean()
      .optional()
      .default(true)
      .describe("Use stale marketplace cache for browsing when the remote registry cannot be reached"),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.requestTimeoutMs)
      .describe("Timeout in milliseconds for registry and entry metadata requests"),
    artifactDownloadTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.artifactDownloadTimeoutMs)
      .describe("Timeout in milliseconds for plugin artifact and signature downloads"),
    cliRequestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.cliRequestTimeoutMs)
      .describe("Timeout in milliseconds for Synergy CLI plugin commands waiting on the local server"),
  })
  .strict()
  .meta({ ref: "PluginMarketplaceConfig" })

export type PluginMarketplace = z.infer<typeof PluginMarketplace>

export const PLUGIN_MARKETPLACE_DEFAULTS = DEFAULT_PLUGIN_MARKETPLACE_CONFIG as Required<PluginMarketplace>

export const ConfigShape = {
  plugin: z.string().array().optional(),
  pluginRuntimePolicy: PluginRuntimePolicy.optional().describe("Plugin runtime isolation policy configuration"),
  pluginMarketplace: PluginMarketplace.optional().describe("Public plugin marketplace registry configuration"),
  pluginConfig: z
    .record(z.string(), z.record(z.string(), z.any()))
    .optional()
    .describe("Per-plugin configuration namespaces. Keys are plugin IDs, values are plugin-specific config."),
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>

declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

export function registerConfig() {
  ConfigExtensions.register("plugin-host", {
    shape: ConfigShape,
    normalize(raw) {
      const result = raw as ConfigValues
      result.plugin ??= []
    },
    merge(current, patch, merged) {
      const a = current as ConfigValues,
        b = patch as ConfigValues,
        result = merged as ConfigValues
      if (a.plugin || b.plugin) result.plugin = mergePluginSpecList(a.plugin ?? [], b.plugin ?? [])
    },
    resolve(raw, configFilepath) {
      const result = raw as ConfigValues
      if (result.plugin)
        for (let i = 0; i < result.plugin.length; i++) {
          try {
            result.plugin[i] = import.meta.resolve!(result.plugin[i], configFilepath)
          } catch {}
        }
    },
  })
  for (const domain of [
    {
      id: "plugins",
      filename: "50-plugins.jsonc",
      label: "Plugins",
      ownedKeys: ["plugin", "pluginConfig", "pluginRuntimePolicy", "pluginMarketplace"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "plugins",
      importable: true,
    },
  ] satisfies ConfigDomain.Definition[])
    ConfigDomain.register(domain)
}
registerConfig()

function mergePluginSpecList(current: string[], patch: string[]): string[] {
  const result: string[] = []
  const indexByKey = new Map<string, number>()

  const push = (spec: string) => {
    const key = pluginSpecMergeKey(spec)
    const index = indexByKey.get(key)
    if (index === undefined) {
      indexByKey.set(key, result.length)
      result.push(spec)
      return
    }
    result[index] = spec
  }

  for (const spec of current) push(spec)
  for (const spec of patch) push(spec)
  return result
}

function pluginSpecMergeKey(spec: string): string {
  const trimmed = spec.trim()
  if (trimmed.startsWith("file://")) return `file:${path.resolve(trimmed.slice("file://".length))}`
  const parsed = PluginSpec.parse(trimmed)
  return parsed.nonRegistry ? `source:${parsed.pkg.replace(/#.*$/, "")}` : `npm:${parsed.pkg}`
}

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
