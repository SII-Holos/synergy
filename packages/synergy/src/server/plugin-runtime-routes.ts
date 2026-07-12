import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Plugin } from "../plugin"
import { ensureRuntime } from "../plugin/loader"
import { pluginRuntimeManager } from "../plugin/runtime"
import { errors } from "./error"

const RuntimeInfo = z
  .object({
    key: z.string(),
    mode: z.enum(["process", "inProcess"]),
    state: z.enum(["starting", "ready", "draining", "crashed", "stopped"]),
    version: z.string(),
    generation: z.string(),
    pid: z.number().optional(),
    inFlight: z.number(),
    startedAt: z.number(),
    lastHeartbeatAt: z.number().optional(),
    lastError: z.string().optional(),
  })
  .meta({ ref: "PluginRuntimeInfo" })

function runtime(pluginId: string) {
  const entry = pluginRuntimeManager.registry.active(pluginId)
  if (!entry) return null
  return {
    key: entry.key,
    mode: entry.mode,
    state: entry.state,
    version: entry.version,
    generation: entry.generation,
    pid: entry.process?.process.pid,
    inFlight: entry.inFlight,
    startedAt: entry.startedAt,
    lastHeartbeatAt: entry.lastHeartbeatAt,
    lastError: entry.lastError,
  }
}

export const PluginRuntimeRoute = new Hono()
  .post(
    "/:pluginId/runtime/reload",
    describeRoute({
      summary: "Reload plugin runtime",
      operationId: "plugin.runtime.reload",
      responses: {
        200: { description: "Runtime", content: { "application/json": { schema: resolver(RuntimeInfo) } } },
        ...errors(404),
      },
    }),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      if (!plugin) return context.json({ message: "Plugin not found" }, 404)
      await pluginRuntimeManager.stop(plugin.id)
      await ensureRuntime(plugin)
      return context.json(runtime(plugin.id)!)
    },
  )
  .post(
    "/:pluginId/runtime/start",
    describeRoute({
      summary: "Start plugin runtime",
      operationId: "plugin.runtime.start",
      responses: {
        200: { description: "Runtime", content: { "application/json": { schema: resolver(RuntimeInfo) } } },
        ...errors(404),
      },
    }),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      if (!plugin) return context.json({ message: "Plugin not found" }, 404)
      await ensureRuntime(plugin)
      return context.json(runtime(plugin.id)!)
    },
  )
  .post(
    "/:pluginId/runtime/stop",
    describeRoute({
      summary: "Stop plugin runtime",
      operationId: "plugin.runtime.stop",
      responses: { 200: { description: "Stopped" }, ...errors(404) },
    }),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      if (!plugin) return context.json({ message: "Plugin not found" }, 404)
      await pluginRuntimeManager.stop(plugin.id)
      return context.json({ stopped: true })
    },
  )
  .get(
    "/:pluginId/runtime/logs",
    describeRoute({
      summary: "Get plugin runtime logs",
      operationId: "plugin.runtime.logs",
      responses: { 200: { description: "Logs" }, ...errors(404) },
    }),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      if (!plugin) return context.json({ message: "Plugin not found" }, 404)
      return context.json(pluginRuntimeManager.logs.list(plugin.id))
    },
  )
