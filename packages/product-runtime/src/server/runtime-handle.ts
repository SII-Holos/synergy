import path from "node:path"
import { existsSync } from "node:fs"
import { registerProductRuntime } from "../product-registration"
import { createLocalHost, createLocalStorage, type LocalRuntimeOptions } from "@ericsanchezok/synergy-local-runtime"
import { RuntimeHandle as HarnessRuntimeHandle, type RuntimeServices } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeReload } from "../runtime/reload"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { MCP } from "@ericsanchezok/synergy-mcp"
import { disposeLibrary } from "@ericsanchezok/synergy-library/register"
import { disposeBrowser } from "@ericsanchezok/synergy-browser-runtime/register"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { registerProductRoutes } from "./routes"
import { GlobalRuntime } from "./global-runtime"

export namespace ProductRuntimeHandle {
  export type Handle = Awaited<ReturnType<typeof open>>

  function services(): RuntimeServices {
    registerProductRoutes()
    const installedSchema = path.resolve(path.dirname(process.execPath), "../schema/config.schema.json")
    const configSchemaPath = existsSync(installedSchema)
      ? installedSchema
      : path.resolve(import.meta.dirname, "../../schema/config.schema.json")
    return {
      configSchemaPath,
      reload: { start: () => RuntimeReload.startAutoReload(), stop: () => RuntimeReload.stopAutoReload() },
      initializeExtensions: () => Plugin.init(),
      disposeExtensions: async () => {
        const errors: unknown[] = []
        for (const dispose of [() => MCP.stop(), disposeBrowser, disposeLibrary]) {
          try {
            await dispose()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, "Product resources cleanup failed")
      },
      resident: { start: (config) => GlobalRuntime.start(config), stop: () => GlobalRuntime.stop() },
      transport: {
        listen: (network, mode) => {
          if (mode === "server") Server.mountApp()
          Server.resumeRequests()
          return Server.listen({ ...network, preferDefaultPort: mode === "server" })
        },
        closeAdmission: () => Server.beginShutdown(),
      },
    }
  }

  export async function openTask(options: LocalRuntimeOptions) {
    const host = options.host ?? createLocalHost()
    return HarnessRuntimeHandle.open({
      ...options,
      host,
      mode: "oneshot",
      storage: options.storage ?? createLocalStorage(host, options.storageReporter),
      composition: {
        register: registerProductRuntime,
        services: () => {
          const { transport: _, resident: __, ...taskServices } = services()
          return taskServices
        },
      },
    })
  }

  export async function open(options: LocalRuntimeOptions) {
    const host = options.host ?? createLocalHost()
    const handle = await HarnessRuntimeHandle.open({
      ...options,
      host,
      storage: options.storage ?? createLocalStorage(host, options.storageReporter),
      composition: { register: registerProductRuntime, services },
    })
    if (!handle.server) throw new Error("Product runtime transport did not start")
    return Object.assign(handle, { server: handle.server })
  }
}
