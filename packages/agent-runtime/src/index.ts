import path from "node:path"
import { RuntimeComponents, RuntimeHandle, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { createLocalClient } from "@ericsanchezok/synergy-local-runtime/client"
import { createLocalHost, createLocalStorage } from "@ericsanchezok/synergy-local-runtime/host"
import type { LocalRuntimeOptions } from "@ericsanchezok/synergy-local-runtime"
import { workerPlan, registerRuntimeWorkers } from "./workers"
import { loadHttpAdapters } from "./adapters"
import { FeatureSelection, type FeaturePlan } from "@ericsanchezok/synergy-util/features"
import { readFeaturePreferences } from "@ericsanchezok/synergy-util/feature-config"

export type AgentRuntimeOptions = Omit<LocalRuntimeOptions, "mode"> & {
  home: string
  components: readonly RuntimeComponent[]
  mode?: "oneshot" | "server"
  listen?: boolean
  configSchemaPath?: string
  features?: FeaturePlan
}

export type AgentRuntime = Awaited<ReturnType<typeof openAgentRuntime>>
export type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"

export async function openAgentRuntime(options: AgentRuntimeOptions) {
  const root = path.resolve(options.home)
  const original = options.host ?? createLocalHost({ home: root, root })
  const features =
    options.features ??
    FeatureSelection.resolve(options.components, await readFeaturePreferences(path.join(original.root, "config")))
  const components = RuntimeComponents.resolve(options.components, features)
  const composition = RuntimeComponents.compose(components, features)
  const adapters = components.some((component) => component.hosts?.includes("http"))
    ? await loadHttpAdapters(components)
    : []
  const host = {
    ...original,
    env: { ...original.env, SYNERGY_WORKER_COMPONENTS: JSON.stringify(workerPlan(components, features)) },
  }
  const runtime = await RuntimeHandle.open({
    ...options,
    mode: options.mode ?? "oneshot",
    host,
    storage: options.storage ?? createLocalStorage(host, options.storageReporter),
    composition: {
      register() {
        composition.register()
        for (const adapter of adapters) adapter.registerHttp()
        ConfigExtensions.completeRegistration()
        registerRuntimeWorkers(components, features)
      },
      services() {
        const services = {
          ...composition.services!(),
          ...(options.configSchemaPath ? { configSchemaPath: options.configSchemaPath } : {}),
        }
        if (options.listen !== false) return services
        const { transport: _, ...selected } = services
        return selected
      },
    },
  })
  return Object.assign(runtime, {
    components: Object.freeze(
      components.map(({ id, version, apiVersion }) => Object.freeze({ id, version, apiVersion })),
    ),
    client: (selector: Parameters<typeof createLocalClient>[1]) => createLocalClient(runtime, selector),
  })
}
