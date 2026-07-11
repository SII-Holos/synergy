import type { AuthHook } from "@ericsanchezok/synergy-plugin/auth"
import { ScopeContext } from "../scope/context"
import { ensureRuntime, type LoadedPlugin } from "./loader"
import { pluginRuntimeManager } from "./runtime"

type AuthContribution = Extract<LoadedPlugin["manifest"]["contributions"][number], { kind: "authProvider" }>

async function invoke(plugin: LoadedPlugin, contribution: AuthContribution, action: string, payload?: unknown) {
  await ensureRuntime(plugin)
  return pluginRuntimeManager.invoke({
    pluginId: plugin.id,
    handlerId: `authProvider:${contribution.id}`,
    value: { action, payload },
    context: {
      scopeId: ScopeContext.current.scope.id,
      directory: ScopeContext.current.directory,
      actor: { type: "lifecycle" },
    },
    pluginDir: plugin.pluginDir,
    manifest: plugin.manifest,
  })
}

export function authHook(plugin: LoadedPlugin, contribution: AuthContribution): AuthHook {
  return {
    provider: contribution.id,
    loader: contribution.provider.hasLoader
      ? async (readAuth, provider) =>
          (await invoke(plugin, contribution, "loader", { auth: await readAuth(), provider })) as Record<
            string,
            unknown
          >
      : undefined,
    methods: (Array.isArray(contribution.provider.methods) ? contribution.provider.methods : []).map(
      (method, index) => {
        const common = { label: method.label, prompts: method.prompts as never }
        if (method.type === "oauth") {
          return {
            ...common,
            type: "oauth" as const,
            authorize: (inputs?: Record<string, string>) =>
              invoke(plugin, contribution, `authorize:${index}`, inputs) as never,
          }
        }
        if (method.type === "import") {
          return {
            ...common,
            type: "import" as const,
            import: (inputs?: Record<string, string>) =>
              invoke(plugin, contribution, `import:${index}`, inputs) as never,
          }
        }
        return {
          ...common,
          type: "api" as const,
          authorize: (inputs?: Record<string, string>) =>
            invoke(plugin, contribution, `authorize:${index}`, inputs) as never,
        }
      },
    ),
  }
}
