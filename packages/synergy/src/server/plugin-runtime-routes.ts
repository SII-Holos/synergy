import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Plugin } from "../plugin/index"
import { getRuntime, startRuntime, stopRuntime, reloadRuntime } from "../plugin-runtime/supervisor"
import { DEFAULT_LIMITS } from "../plugin-runtime/health"
import { errors } from "./error"

// ── Response schemas ──

const RuntimeInfo = z
  .object({
    mode: z.enum(["in-process", "worker", "process"]),
    pid: z.number().optional(),
    state: z.enum(["starting", "ready", "unhealthy", "stopped", "crashed"]),
    restarts: z.number(),
    lastHeartbeatAt: z.number().optional(),
    memoryMb: z.number().optional(),
    limits: z.object({
      STARTUP_TIMEOUT_MS: z.number(),
      REQUEST_TIMEOUT_MS: z.number(),
      SHUTDOWN_GRACE_MS: z.number(),
      CONCURRENT_REQUESTS: z.number(),
      MAX_LOG_BYTES_PER_MINUTE: z.number(),
      MEMORY_MB: z.number(),
      HEARTBEAT_INTERVAL_MS: z.number(),
      HEARTBEAT_MISSES_BEFORE_KILL: z.number(),
    }),
    lastError: z.string().optional(),
  })
  .meta({ ref: "PluginRuntimeInfo" })

const LogEntry = z
  .object({
    timestamp: z.number(),
    level: z.string(),
    message: z.string(),
  })
  .meta({ ref: "PluginRuntimeLogEntry" })

// ── Helpers ──

function runtimeToResponse(pluginId: string) {
  const entry = getRuntime(pluginId)
  if (!entry) return null
  return {
    mode: entry.mode,
    pid: entry.pid,
    state: entry.state,
    restarts: entry.restarts,
    lastHeartbeatAt: entry.lastHeartbeatAt,
    memoryMb: entry.memoryMb,
    limits: DEFAULT_LIMITS,
    lastError: entry.lastError,
  }
}

// ── Route group ──

export const PluginRuntimeRoute = new Hono()

  // POST /:pluginId/runtime/reload
  .post(
    "/:pluginId/runtime/reload",
    describeRoute({
      summary: "Reload plugin runtime",
      description: "Stop and restart the plugin runtime process.",
      operationId: "plugin.runtime.reload",
      responses: {
        200: {
          description: "Runtime state after reload",
          content: {
            "application/json": { schema: resolver(RuntimeInfo.nullable()) },
          },
        },
        ...errors(404, 500),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      try {
        await reloadRuntime(pluginId)
        return c.json(runtimeToResponse(pluginId))
      } catch (err: any) {
        // If reloadRuntime threw because the plugin wasn't registered, start it fresh
        await startRuntime(pluginId, {
          mode: "in-process",
          entryPath: plugin.pluginDir,
          pluginDir: plugin.pluginDir,
        })
        return c.json(runtimeToResponse(pluginId))
      }
    },
  )

  // POST /:pluginId/runtime/stop
  .post(
    "/:pluginId/runtime/stop",
    describeRoute({
      summary: "Stop plugin runtime",
      description: "Gracefully stop the plugin runtime process.",
      operationId: "plugin.runtime.stop",
      responses: {
        200: {
          description: "Runtime state after stop",
          content: {
            "application/json": { schema: resolver(RuntimeInfo.nullable()) },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      await stopRuntime(pluginId, true)
      return c.json(runtimeToResponse(pluginId))
    },
  )

  // POST /:pluginId/runtime/start
  .post(
    "/:pluginId/runtime/start",
    describeRoute({
      summary: "Start plugin runtime",
      description: "Start the plugin runtime process.",
      operationId: "plugin.runtime.start",
      responses: {
        200: {
          description: "Runtime state after start",
          content: {
            "application/json": { schema: resolver(RuntimeInfo.nullable()) },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      await startRuntime(pluginId, {
        mode: "in-process",
        entryPath: plugin.pluginDir,
        pluginDir: plugin.pluginDir,
      })
      return c.json(runtimeToResponse(pluginId))
    },
  )

  // GET /:pluginId/runtime/logs
  .get(
    "/:pluginId/runtime/logs",
    describeRoute({
      summary: "Get plugin runtime logs",
      description: "Return recent log entries for the plugin runtime.",
      operationId: "plugin.runtime.logs",
      responses: {
        200: {
          description: "Recent runtime log entries",
          content: {
            "application/json": { schema: resolver(LogEntry.array()) },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      // TODO: Read from plugin log store when log capture is implemented
      return c.json([])
    },
  )
