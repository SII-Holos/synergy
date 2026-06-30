import Ajv, { type ErrorObject } from "ajv"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"

const ajv = new Ajv({ allErrors: true, strict: false })

export class PluginConfigValidationError extends Error {
  readonly issues: string[]

  constructor(pluginId: string, issues: string[]) {
    super(`Plugin config for "${pluginId}" does not match contributes.config.schema: ${issues.join("; ")}`)
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

function validatePluginConfig(pluginId: string, values: Record<string, unknown>, manifest?: PluginManifest | null) {
  const schema = manifest?.contributes?.config?.schema
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

export async function getPluginConfig(pluginId: string): Promise<Record<string, unknown>> {
  const domain = await Config.domainGet("plugins")
  const values = domain.pluginConfig?.[pluginId]
  return values && typeof values === "object" && !Array.isArray(values) ? (values as Record<string, unknown>) : {}
}

export async function replacePluginConfig(
  pluginId: string,
  values: unknown,
  options: { manifest?: PluginManifest | null } = {},
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
  options: { manifest?: PluginManifest | null } = {},
): Promise<Record<string, unknown>> {
  const current = await getPluginConfig(pluginId)
  return replacePluginConfig(pluginId, { ...current, [key]: value }, options)
}
