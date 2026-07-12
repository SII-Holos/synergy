import Ajv2020 from "ajv/dist/2020"
import type { ErrorObject, ValidateFunction } from "ajv"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { ScopeContext } from "../scope/context"
import { PluginRuntimeError } from "../plugin-runtime/manager"
import { contribution, ensureRuntime, getPlugin, markContributionDegraded } from "./loader"
import { pluginRuntimeManager } from "./runtime"

export type PluginOperationErrorCode =
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_DISABLED"
  | "PLUGIN_UNAVAILABLE"
  | "CONTRIBUTION_NOT_FOUND"
  | "CONTRIBUTION_DISABLED"
  | "INPUT_INVALID"
  | "OUTPUT_INVALID"
  | "CAPABILITY_DENIED"
  | "CONFLICT"
  | "TIMEOUT"
  | "CANCELLED"
  | "RUNTIME_ERROR"

export class PluginOperationError extends Error {
  constructor(
    readonly code: PluginOperationErrorCode,
    message: string,
    readonly issues?: ErrorObject[] | null,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "PluginOperationError"
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validators = new WeakMap<object, ValidateFunction>()

function validator(schema: Record<string, unknown>) {
  let validate = validators.get(schema)
  if (!validate) {
    validate = ajv.compile(schema)
    validators.set(schema, validate)
  }
  return validate
}

export function validatePluginOperationValue(
  schema: Record<string, unknown>,
  value: unknown,
  code: "INPUT_INVALID" | "OUTPUT_INVALID",
) {
  const check = validator(schema)
  if (check(value)) return
  throw new PluginOperationError(code, ajv.errorsText(check.errors), check.errors)
}

export function resolvePluginOperation(
  manifest: { contributions: readonly unknown[] },
  operationId: string,
  caller: "ui" | "sdk",
): Extract<PluginManifestType["contributions"][number], { kind: "operation" }> {
  const operation = manifest.contributions.find((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const value = item as Record<string, unknown>
    return value.kind === "operation" && value.id === operationId
  }) as Extract<PluginManifestType["contributions"][number], { kind: "operation" }> | undefined
  if (!operation) {
    throw new PluginOperationError("CONTRIBUTION_NOT_FOUND", `Plugin operation not found: ${operationId}`)
  }
  if (!operation.expose?.includes(caller)) {
    throw new PluginOperationError("CAPABILITY_DENIED", `Plugin operation ${operationId} is not exposed to ${caller}`)
  }
  return operation
}

export async function invokePluginOperation(input: {
  pluginId: string
  operationId: string
  value: unknown
  caller: "ui" | "sdk"
  sessionId?: string
  signal?: AbortSignal
}) {
  const plugin = await getPlugin(input.pluginId)
  if (!plugin) throw new PluginOperationError("PLUGIN_NOT_FOUND", `Plugin not found: ${input.pluginId}`)
  if (!plugin.enabledScopes.has(ScopeContext.current.scope.id)) {
    throw new PluginOperationError("PLUGIN_DISABLED", `Plugin is not enabled in this Scope: ${input.pluginId}`)
  }
  const registered = contribution(plugin, "operation", input.operationId)
  if (!registered)
    throw new PluginOperationError("CONTRIBUTION_NOT_FOUND", `Plugin operation not found: ${input.operationId}`)
  const operation = resolvePluginOperation({ contributions: [registered] }, input.operationId, input.caller)
  validatePluginOperationValue(operation.input, input.value, "INPUT_INVALID")
  try {
    await ensureRuntime(plugin)
    const result = await pluginRuntimeManager.invoke({
      pluginId: plugin.id,
      handlerId: `operation:${operation.id}`,
      value: input.value,
      context: {
        scopeId: ScopeContext.current.scope.id,
        sessionId: input.sessionId,
        directory: ScopeContext.current.directory,
        actor: { type: input.caller },
      },
      pluginDir: plugin.pluginDir,
      manifest: plugin.manifest,
      timeoutMs: operation.timeoutMs,
      signal: input.signal,
    })
    validatePluginOperationValue(operation.output, result, "OUTPUT_INVALID")
    return result
  } catch (error) {
    if (error instanceof PluginOperationError) throw error
    markContributionDegraded(plugin, operation.id, error)
    if (error instanceof PluginRuntimeError) {
      const domainCode = (error as PluginRuntimeError & { domainCode?: string }).domainCode
      if (domainCode === "CONFLICT") {
        throw new PluginOperationError("CONFLICT", error.message, undefined, { cause: error })
      }
      if (domainCode === "CONTRIBUTION_DISABLED") {
        throw new PluginOperationError("CONTRIBUTION_DISABLED", error.message, undefined, { cause: error })
      }
      const code =
        error.code === "TIMEOUT" || error.code === "CANCELLED" || error.code === "PLUGIN_UNAVAILABLE"
          ? error.code
          : "RUNTIME_ERROR"
      throw new PluginOperationError(code, error.message, undefined, { cause: error })
    }
    const domainCode = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
    if (domainCode === "CONFLICT") {
      throw new PluginOperationError("CONFLICT", error instanceof Error ? error.message : "Plugin command conflict")
    }
    if (domainCode === "CONTRIBUTION_DISABLED") {
      throw new PluginOperationError(
        "CONTRIBUTION_DISABLED",
        error instanceof Error ? error.message : "Plugin contribution is disabled",
      )
    }
    throw new PluginOperationError("RUNTIME_ERROR", error instanceof Error ? error.message : String(error), undefined, {
      cause: error,
    })
  }
}
