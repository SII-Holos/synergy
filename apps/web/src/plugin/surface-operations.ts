import type { PluginManifestContribution, PluginUILifetime, PluginUIOperations } from "@ericsanchezok/synergy-plugin"
import type { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

export function createPluginSurfaceOperations(input: {
  client: Pick<ReturnType<typeof createSynergyClient>, "plugin">
  pluginId: string
  scopeId: string
  sessionId?: string
  lifetime: PluginUILifetime
  contributions: PluginManifestContribution[]
}): PluginUIOperations {
  async function invoke<Output>(
    type: "query" | "command",
    id: string,
    value?: unknown,
    signal?: AbortSignal,
  ): Promise<Output> {
    input.lifetime.signal.throwIfAborted()
    const declared = input.contributions.find((item) => item.kind === "operation" && item.id === id)
    if (!declared || declared.kind !== "operation" || declared.type !== type || !declared.expose.includes("ui")) {
      throw new Error(`Plugin operation ${id} is not a UI-exposed ${type}`)
    }
    const invocationSignal = signal ? AbortSignal.any([signal, input.lifetime.signal]) : input.lifetime.signal
    const result = await input.client.plugin.invokeOperation(
      {
        pluginId: input.pluginId,
        operationId: id,
        scopeID: input.scopeId,
        input: value ?? {},
        sessionId: input.sessionId,
      },
      {
        signal: invocationSignal,
        headers: { "x-synergy-plugin-caller": "ui" },
        throwOnError: false,
      },
    )
    invocationSignal.throwIfAborted()
    if (result.error) {
      const error = result.error as Record<string, unknown>
      throw Object.assign(new Error(typeof error.message === "string" ? error.message : "Plugin operation failed"), {
        code: error.code,
        issues: error.issues,
      })
    }
    const body = result.data
    if (!body || typeof body !== "object" || !("data" in body)) {
      throw new Error("Plugin operation returned an invalid response")
    }
    return body.data as Output
  }
  return {
    query: (id, value, options) => invoke("query", id, value, options?.signal),
    command: (id, value, options) => invoke("command", id, value, options?.signal),
  }
}
