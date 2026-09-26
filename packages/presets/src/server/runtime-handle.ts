import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { createLocalHost, type LocalRuntimeOptions } from "@ericsanchezok/synergy-local-runtime"
import { fullComponents } from "../components"
import { webApp } from "@ericsanchezok/synergy-server/web-app"

export namespace PresetRuntimeHandle {
  export type Handle = Awaited<ReturnType<typeof open>>

  export type Options = LocalRuntimeOptions & { webAppDirectory?: string; configSchemaPath?: string }

  const components = (options: Options) => [
    ...fullComponents(),
    ...(options.webAppDirectory ? [webApp({ directory: options.webAppDirectory })] : []),
  ]

  export async function openTask(options: Options) {
    const host = options.host ?? createLocalHost()
    return openAgentRuntime({
      ...options,
      host,
      home: host.root,
      mode: "oneshot",
      listen: false,
      components: components(options),
    })
  }

  export async function open(options: Options) {
    const host = options.host ?? createLocalHost()
    const handle = await openAgentRuntime({
      ...options,
      host,
      home: host.root,
      components: components(options),
    })
    if (!handle.server) {
      await handle.close()
      throw new Error("Full preset HTTP transport did not start")
    }
    return Object.assign(handle, { server: handle.server })
  }
}
