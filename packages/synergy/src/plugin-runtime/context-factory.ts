import type { PluginInvocationContext, PluginLogger, PluginRuntimeIdentity } from "@ericsanchezok/synergy-plugin"
import type { PluginHostServiceMethod, RuntimeInvocationContextData } from "./protocol.js"

export function createPluginInvocationContext(input: {
  requestId: string
  data: RuntimeInvocationContextData
  runtime: PluginRuntimeIdentity
  signal: AbortSignal
  capabilities: ReadonlySet<string>
  log: PluginLogger
  invokeHost(method: PluginHostServiceMethod, params: unknown): Promise<unknown>
}): PluginInvocationContext {
  const { capabilities } = input
  const session =
    capabilities.has("session.read") || capabilities.has("session.control")
      ? {
          ...(capabilities.has("session.read")
            ? { get: (sessionId: string) => input.invokeHost("session.get", { sessionId }) }
            : {}),
          ...(capabilities.has("session.control")
            ? { abort: (sessionId: string) => input.invokeHost("session.abort", { sessionId }) as Promise<void> }
            : {}),
        }
      : undefined
  const workspace =
    capabilities.has("workspace.read") || capabilities.has("workspace.write")
      ? {
          ...(capabilities.has("workspace.read")
            ? {
                read: (path: string) => input.invokeHost("workspace.read", { path }) as Promise<string>,
                metadata: () => input.invokeHost("workspace.metadata", {}),
              }
            : {}),
          ...(capabilities.has("workspace.write")
            ? {
                write: (path: string, content: string) =>
                  input.invokeHost("workspace.write", { path, content }) as Promise<void>,
              }
            : {}),
        }
      : undefined

  return {
    requestId: input.requestId,
    scopeId: input.data.scopeId,
    sessionId: input.data.sessionId,
    runtime: input.runtime,
    actor: input.data.actor,
    signal: input.signal,
    log: input.log,
    events: {
      publish: (eventId, payload) => input.invokeHost("event.publish", { eventId, payload }) as Promise<void>,
    },
    session,
    workspace,
    task: capabilities.has("task.delegate")
      ? {
          start: (value) => input.invokeHost("task.start", value) as never,
          current: () => input.invokeHost("task.current", {}) as never,
          get: (value) => input.invokeHost("task.get", value) as never,
          cancel: (value) => input.invokeHost("task.cancel", value) as Promise<void>,
        }
      : undefined,
    blueprint: capabilities.has("blueprint.delegate")
      ? {
          create: (value) => input.invokeHost("blueprint.create", value) as never,
          start: (loopID) => input.invokeHost("blueprint.start", { loopID }) as never,
          get: (loopID) => input.invokeHost("blueprint.get", { loopID }) as never,
          list: () => input.invokeHost("blueprint.list", {}) as never,
          cancel: (loopID) => input.invokeHost("blueprint.cancel", { loopID }) as never,
        }
      : undefined,
    lightloop: capabilities.has("lightloop.delegate")
      ? {
          enable: (value) => input.invokeHost("lightloop.enable", value) as Promise<void>,
        }
      : undefined,
    settings:
      capabilities.has("settings.read") || capabilities.has("settings.write")
        ? {
            ...(capabilities.has("settings.read")
              ? { get: () => input.invokeHost("settings.get", {}) as Promise<Record<string, unknown>> }
              : {}),
            ...(capabilities.has("settings.write")
              ? {
                  replace: (values: Record<string, unknown>) =>
                    input.invokeHost("settings.replace", { values }) as Promise<void>,
                }
              : {}),
          }
        : undefined,
    secrets: capabilities.has("secrets")
      ? {
          get: (key) => input.invokeHost("secrets.get", { key }) as Promise<string | undefined>,
          set: (key, value) => input.invokeHost("secrets.set", { key, value }) as Promise<void>,
          delete: (key) => input.invokeHost("secrets.delete", { key }) as Promise<void>,
        }
      : undefined,
    tools: capabilities.has("tool.invoke")
      ? { invoke: (toolId, value) => input.invokeHost("tool.invoke", { toolId, input: value }) as never }
      : undefined,
  }
}
