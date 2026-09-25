import path from "node:path"
import { RuntimeComponents, RuntimeHandle, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { registerAgentWorkerEntrypoint } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import { registerPolicyWorkerEntrypoint } from "@ericsanchezok/synergy-harness/enforcement/policy-worker/process-host"
import {
  createLocalClient,
  createLocalHost,
  createLocalStorage,
  type LocalRuntimeOptions,
} from "@ericsanchezok/synergy-local-runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { workerPlan } from "./workers"

export type AgentRuntimeOptions = Omit<LocalRuntimeOptions, "mode"> & {
  home: string
  components?: readonly RuntimeComponent[]
  mode?: "oneshot" | "server"
  listen?: boolean
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
    ? await Promise.all(
        components.flatMap((component) =>
          component.adapters?.http ? [import(component.adapters.http.href) as Promise<{ registerHttp(): void }>] : [],
        ),
      )
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
        registerAgentWorkerEntrypoint(new URL("./agent-worker.ts", import.meta.url))
        registerPolicyWorkerEntrypoint(new URL("./policy-worker.ts", import.meta.url))
      },
      services() {
        const services = composition.services!()
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
