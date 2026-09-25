import path from "node:path"
import { existsSync } from "node:fs"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { createLocalHost, type LocalRuntimeOptions } from "@ericsanchezok/synergy-local-runtime"
import { fullComponents } from "../components"
import { presetWebApp } from "./web-app"

export namespace PresetRuntimeHandle {
  export type Handle = Awaited<ReturnType<typeof open>>

  function configSchemaPath() {
    const installed = path.resolve(path.dirname(process.execPath), "../schema/config.schema.json")
    return existsSync(installed) ? installed : path.resolve(import.meta.dirname, "../../schema/config.schema.json")
  }

  export async function openTask(options: LocalRuntimeOptions) {
    const host = options.host ?? createLocalHost()
    return openAgentRuntime({
      ...options,
      host,
      home: host.root,
      mode: "oneshot",
      listen: false,
      configSchemaPath: configSchemaPath(),
      components: [...fullComponents(), presetWebApp()],
    })
  }

  export async function open(options: LocalRuntimeOptions) {
    const host = options.host ?? createLocalHost()
    const handle = await openAgentRuntime({
      ...options,
      host,
      home: host.root,
      configSchemaPath: configSchemaPath(),
      components: [...fullComponents(), presetWebApp()],
    })
    if (!handle.server) {
      await handle.close()
      throw new Error("Full preset HTTP transport did not start")
    }
    return Object.assign(handle, { server: handle.server })
  }
}
