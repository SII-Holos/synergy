import path from "node:path"
import { RuntimeComponents, RuntimeHandle, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import {
  createLocalClient,
  createLocalHost,
  createLocalStorage,
  type LocalRuntimeOptions,
} from "@ericsanchezok/synergy-local-runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { workerPlan, registerRuntimeWorkers } from "./workers"
import { loadHttpAdapters } from "./adapters"

export type AgentRuntimeOptions = Omit<LocalRuntimeOptions, "mode"> & {
  home: string
  components?: readonly RuntimeComponent[]
  mode?: "oneshot" | "server"
  listen?: boolean
  configSchemaPath?: string
}

export type AgentRuntime = Awaited<ReturnType<typeof openAgentRuntime>>
export type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"

export async function openAgentRuntime(options: AgentRuntimeOptions) {
  const components = RuntimeComponents.resolve([
    localRuntime({ workers: false }),
    plugins(),
    ...(options.components ?? []),
  ])
  const composition = RuntimeComponents.compose(components)
  const adapters = components.some((component) => component.hosts?.includes("http"))
    ? await loadHttpAdapters(components)
    : []
  const root = path.resolve(options.home)
  const original = options.host ?? createLocalHost({ home: root, root })
  const host = {
    ...original,
    env: { ...original.env, SYNERGY_WORKER_COMPONENTS: JSON.stringify(workerPlan(components)) },
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
        registerRuntimeWorkers(components)
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
