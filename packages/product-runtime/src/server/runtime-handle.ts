import path from "node:path"
import { existsSync } from "node:fs"
import "../product-registration"
import { RuntimeHandle as LocalRuntimeHandle, type RuntimeServices } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeReload } from "../runtime/reload"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { MCP } from "@ericsanchezok/synergy-agent-integrations/mcp"
import { disposeLibrary } from "@ericsanchezok/synergy-library/register"
import { disposeBrowser } from "@ericsanchezok/synergy-browser-runtime/register"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { registerProductRoutes } from "./routes"
import { GlobalRuntime } from "./global-runtime"

export namespace RuntimeHandle {
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

  export async function openTask(options: Omit<Parameters<typeof LocalRuntimeHandle.open>[0], "services">) {
    const { transport: _, resident: __, ...taskServices } = services()
    return LocalRuntimeHandle.open({ ...options, mode: "oneshot", services: taskServices })
  }

  export async function open(options: Omit<Parameters<typeof LocalRuntimeHandle.open>[0], "services">) {
    const handle = await LocalRuntimeHandle.open({ ...options, services: services() })
    if (!handle.server) throw new Error("Product runtime transport did not start")
    return { ...handle, server: handle.server }
  }
}
