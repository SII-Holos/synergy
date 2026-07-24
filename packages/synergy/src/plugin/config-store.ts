import Ajv, { type ErrorObject } from "ajv"
import type { PluginManifestType, PluginSettingCondition } from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"

const ajv = new Ajv({ allErrors: true, strict: false })

export class PluginConfigValidationError extends Error {
  readonly issues: string[]

  constructor(pluginId: string, issues: string[]) {
    super(`Plugin settings for "${pluginId}" do not match the declared settings schema: ${issues.join("; ")}`)
    this.name = "PluginConfigValidationError"
    this.issues = issues
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  const formatted = (errors ?? []).map((error) => {
    const path = error.instancePath || "/"
    return `${path} ${error.message ?? "is invalid"}`
  })
  return formatted.length > 0 ? formatted : ["schema validation failed"]
}

function normalizePluginConfig(pluginId: string, values: unknown): Record<string, unknown> {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new PluginConfigValidationError(pluginId, ["config must be an object"])
  }
  return values as Record<string, unknown>
}

function settingsSchema(manifest?: PluginManifestType | null) {
  return manifest?.contributions.find((item) => item.kind === "ui.settings")?.formSchema
}

function settingsProperties(manifest?: PluginManifestType | null): Record<string, unknown> | undefined {
  const schema = settingsSchema(manifest)
  if (!schema || typeof schema.properties !== "object" || !schema.properties) return
  return schema.properties as Record<string, unknown>
}

function schemaDefaults(manifest?: PluginManifestType | null): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settingsProperties(manifest) ?? {}).flatMap(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !("default" in value)) return []
      return [[key, structuredClone((value as { default: unknown }).default)]]
    }),
  )
}

function validatePluginConfig(pluginId: string, values: Record<string, unknown>, manifest?: PluginManifestType | null) {
  const schema = settingsSchema(manifest)
  if (!schema || Object.keys(schema).length === 0) return

  let validate
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new PluginConfigValidationError(pluginId, [`invalid config schema: ${message}`])
  }

  if (!validate(values)) {
    throw new PluginConfigValidationError(pluginId, formatAjvErrors(validate.errors))
  }
}

export async function getPluginConfig(
  pluginId: string,
  options: { manifest?: PluginManifestType | null } = {},
): Promise<Record<string, unknown>> {
  const domain = await Config.domainGet("plugins")
  const values = domain.pluginConfig?.[pluginId]
  const stored =
    values && typeof values === "object" && !Array.isArray(values) ? (values as Record<string, unknown>) : {}
  const schema = settingsSchema(options.manifest)
  const properties = settingsProperties(options.manifest)
  const effective =
    properties && schema?.additionalProperties === false
      ? Object.fromEntries(Object.keys(properties).flatMap((key) => (key in stored ? [[key, stored[key]]] : [])))
      : stored
  return { ...schemaDefaults(options.manifest), ...effective }
}

export function matchesPluginSettingCondition(
  condition: PluginSettingCondition,
  values: Record<string, unknown>,
): boolean {
  return values[condition.setting] === condition.equals
}

export async function replacePluginConfig(
  pluginId: string,
  values: unknown,
  options: { manifest?: PluginManifestType | null } = {},
): Promise<Record<string, unknown>> {
  const normalized = normalizePluginConfig(pluginId, values)
  validatePluginConfig(pluginId, normalized, options.manifest)

  const domain = await Config.domainGet("plugins")
  await Config.domainUpdate(
    "plugins",
    {
      ...domain,
      pluginConfig: {
        ...(domain.pluginConfig ?? {}),
        [pluginId]: normalized,
      },
    } as any,
    { mode: "replace-domain" },
  )
  return normalized
}

export async function setPluginConfigKey(
  pluginId: string,
  key: string,
  value: unknown,
  options: { manifest?: PluginManifestType | null } = {},
): Promise<Record<string, unknown>> {
  const current = await getPluginConfig(pluginId, options)
  return replacePluginConfig(pluginId, { ...current, [key]: value }, options)
}
