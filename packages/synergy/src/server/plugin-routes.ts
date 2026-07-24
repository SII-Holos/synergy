import fs from "fs/promises"
import path from "path"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Plugin } from "../plugin"
import { getPluginConfig } from "../plugin/config-store"
import { PluginApprovalRequiredError } from "../plugin/install"
import { invokePluginOperation, PluginOperationError } from "../plugin/operation"
import { reloadDevelopmentGeneration, getLoadedPlugins } from "../plugin/loader"
import { PluginStatusSchema } from "../plugin/status"
import { isPathContained } from "../util/path-contain"
import { errors } from "./error"
import { ScopeContext } from "../scope/context"
import {
  buildApprovalReview,
  approve as approvePlugin,
  resolveRegistrySpec,
  ApprovalStaleReviewError,
  ApprovalPluginNotFoundError,
  ApprovalNotRequiredError,
  ApprovalInvalidError,
  ApprovalApproveBodySchema,
  ApprovalReviewSchema,
} from "../plugin/consent/approval-service"
import { PluginInstallationTransaction } from "../plugin/installation-transaction"
import { reload } from "../plugin/lifecycle"
import { readApprovals } from "../plugin/consent/approval-store"

const JsonValue = z.any()
const UIContribution = z.object({
  pluginId: z.string(),
  name: z.string(),
  version: z.string(),
  generation: z.string(),
  scopeId: z.string(),
  capabilities: z.array(z.string()),
  contributions: z.array(z.record(z.string(), z.unknown())),
  uiArtifact: z.object({ entry: z.string(), sha256: z.string() }).optional(),
})

const InvokeBody = z.object({ input: JsonValue.optional(), sessionId: z.string().optional() })
const PluginConfigUpdate = z.record(z.string(), z.unknown()).meta({ ref: "PluginConfigUpdate" })

function uiContributions(plugin: Plugin.LoadedPlugin) {
  return {
    pluginId: plugin.id,
    name: plugin.name,
    version: plugin.manifest.version,
    generation: plugin.manifest.artifacts.generation,
    scopeId: ScopeContext.current.scope.id,
    capabilities: plugin.manifest.capabilities.map((item) => item.id),
    contributions: plugin.manifest.contributions.filter(
      (item) =>
        item.kind.startsWith("ui.") ||
        item.kind === "event" ||
        (item.kind === "operation" && item.expose.includes("ui")),
    ),
    uiArtifact: plugin.manifest.artifacts.ui,
  }
}

function operationStatus(code: PluginOperationError["code"]): 400 | 403 | 404 | 408 | 409 | 503 {
  if (code === "PLUGIN_NOT_FOUND" || code === "CONTRIBUTION_NOT_FOUND") return 404
  if (code === "CAPABILITY_DENIED" || code === "PLUGIN_DISABLED" || code === "CONTRIBUTION_DISABLED") return 403
  if (code === "TIMEOUT" || code === "CANCELLED") return 408
  if (code === "CONFLICT") return 409
  if (code === "PLUGIN_UNAVAILABLE") return 503
  return 400
}

const StructuredErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
})
const ApprovalReviewErrorSchema = StructuredErrorSchema.extend({
  review: ApprovalReviewSchema,
})

export const PluginRoute = new Hono()
  .get(
    "/ui/contributions",
    describeRoute({
      summary: "List enabled plugin UI contributions",
      operationId: "plugin.listUIContributions",
      responses: {
        200: {
          description: "Contributions",
          content: { "application/json": { schema: resolver(z.array(UIContribution)) } },
        },
      },
    }),
    async (context) => context.json((await Plugin.getLoaded()).map(uiContributions)),
  )
  .get(
    "/assets/:pluginId/:generation/:asset{.+}",
    describeRoute({
      summary: "Serve a generated plugin artifact",
      operationId: "plugin.serveAsset",
      responses: { 200: { description: "Asset" }, ...errors(404) },
    }),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      if (!plugin || plugin.manifest.artifacts.generation !== context.req.param("generation"))
        return context.json({ message: "Plugin generation not found" }, 404)
      const relative = context.req.param("asset")
      const file = path.resolve(plugin.pluginDir, relative)
      if (!relative || !isPathContained(plugin.pluginDir, file))
        return context.json({ message: "Asset not found" }, 404)
      const data = await fs.readFile(file).catch(() => undefined)
      if (!data) return context.json({ message: "Asset not found" }, 404)
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      }
      return new Response(new Uint8Array(data), {
        headers: {
          "content-type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-store",
        },
      })
    },
  )
  .post(
    "/:pluginId/operations/:operationId/invoke",
    describeRoute({
      summary: "Invoke a declared plugin operation",
      operationId: "plugin.invokeOperation",
      responses: { 200: { description: "Operation result" }, ...errors(400, 403, 404, 408, 409, 503) },
    }),
    validator("json", InvokeBody),
    async (context) => {
      const body = context.req.valid("json")
      const caller = context.req.header("x-synergy-plugin-caller") === "ui" ? "ui" : "sdk"
      try {
        const result = await invokePluginOperation({
          pluginId: context.req.param("pluginId"),
          operationId: context.req.param("operationId"),
          value: body.input ?? {},
          sessionId: body.sessionId,
          caller,
          signal: context.req.raw.signal,
        })
        return context.json({ data: result })
      } catch (error) {
        if (error instanceof PluginOperationError)
          return context.json(
            { code: error.code, message: error.message, issues: error.issues },
            operationStatus(error.code),
          )
        throw error
      }
    },
  )
  .get("/:pluginId/config/schema", async (context) => {
    const manifest = await Plugin.manifest(context.req.param("pluginId"))
    if (!manifest) return context.json({ message: "Plugin not found" }, 404)
    const settings = manifest.contributions.find((item) => item.kind === "ui.settings")
    return context.json(settings?.formSchema ?? {})
  })
  .get(
    "/:pluginId/config",
    describeRoute({
      operationId: "plugin.getConfig",
      responses: { 200: { description: "Plugin settings" }, ...errors(404) },
    }),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      if (!plugin) return context.json({ message: "Plugin not found" }, 404)
      return context.json(await getPluginConfig(plugin.id, { manifest: plugin.manifest }))
    },
  )
  .patch(
    "/:pluginId/config",
    describeRoute({
      operationId: "plugin.updateConfig",
      responses: { 200: { description: "Plugin settings" }, ...errors(404) },
    }),
    validator("json", PluginConfigUpdate),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      if (!plugin) return context.json({ message: "Plugin not found" }, 404)
      return context.json(await Plugin.updateConfig(plugin, context.req.valid("json")))
    },
  )
  .get(
    "/:pluginId/status",
    describeRoute({
      operationId: "plugin.status",
      responses: {
        200: {
          description: "Plugin status",
          content: { "application/json": { schema: resolver(PluginStatusSchema) } },
        },
        ...errors(404),
      },
    }),
    async (context) => {
      const status = await Plugin.getStatus(context.req.param("pluginId"))
      return status ? context.json(status) : context.json({ message: "Plugin not found" }, 404)
    },
  )
  .post(
    "/dev/reload",
    validator("json", z.object({ pluginId: z.string(), generation: z.string(), artifactDir: z.string() })),
    async (context) => {
      const body = context.req.valid("json")
      const plugin = await reloadDevelopmentGeneration(body)
      return context.json({ pluginId: plugin.id, generation: plugin.manifest.artifacts.generation })
    },
  )

export const ApiPluginRoute = new Hono()
  .get(
    "/",
    describeRoute({
      operationId: "api.plugins.list",
      responses: {
        200: {
          description: "Installed plugins",
          content: { "application/json": { schema: resolver(z.array(PluginStatusSchema)) } },
        },
      },
    }),
    async (context) => context.json(await Plugin.getAllStatus()),
  )
  .get(
    "/:pluginId",
    describeRoute({
      operationId: "api.plugins.get",
      responses: { 200: { description: "Plugin detail" }, ...errors(404) },
    }),
    async (context) => {
      const pluginId = context.req.param("pluginId")
      const status = await Plugin.getStatus(pluginId)
      if (!status) return context.json({ message: "Plugin not found" }, 404)
      const plugin = await Plugin.get(pluginId)
      return context.json({ ...status, ...(plugin ? { manifest: plugin.manifest } : {}) })
    },
  )
  .delete(
    "/:pluginId",
    describeRoute({
      operationId: "api.plugins.remove",
      responses: { 200: { description: "Removed" }, ...errors(404) },
    }),
    async (context) => {
      await Plugin.remove(context.req.param("pluginId"), {
        force: context.req.query("force") === "true",
      })
      return context.json({ removed: true })
    },
  )
  .get(
    "/:pluginId/approval-review",
    describeRoute({
      operationId: "api.plugins.getApprovalReview",
      responses: {
        200: {
          description: "Approval review",
          content: { "application/json": { schema: resolver(ApprovalReviewSchema) } },
        },
        404: {
          description: "Plugin not found",
          content: { "application/json": { schema: resolver(StructuredErrorSchema) } },
        },
        409: {
          description: "Approval not required",
          content: { "application/json": { schema: resolver(StructuredErrorSchema) } },
        },
        422: {
          description: "Invalid plugin",
          content: { "application/json": { schema: resolver(StructuredErrorSchema) } },
        },
      },
    }),
    async (context) => {
      const pluginId = context.req.param("pluginId")
      try {
        const review = await buildApprovalReview({ kind: "configured", pluginId })
        return context.json(review)
      } catch (err) {
        if (err instanceof ApprovalPluginNotFoundError)
          return context.json({ code: err.code, message: err.message }, 404)
        if (err instanceof ApprovalNotRequiredError) return context.json({ code: err.code, message: err.message }, 409)
        if (err instanceof ApprovalInvalidError) return context.json({ code: err.code, message: err.message }, 422)
        throw err
      }
    },
  )
  .post(
    "/approve",
    describeRoute({
      operationId: "api.plugins.approve",
      responses: {
        200: { description: "Approved", content: { "application/json": { schema: resolver(PluginStatusSchema) } } },
        400: { description: "Bad request" },
        404: {
          description: "Plugin not found",
          content: { "application/json": { schema: resolver(StructuredErrorSchema) } },
        },
        409: {
          description: "Stale review",
          content: { "application/json": { schema: resolver(ApprovalReviewErrorSchema) } },
        },
        422: {
          description: "Invalid plugin",
          content: { "application/json": { schema: resolver(StructuredErrorSchema) } },
        },
      },
    }),
    validator("json", ApprovalApproveBodySchema),
    async (context) => {
      const body = context.req.valid("json")
      try {
        if (body.target.kind === "configured") {
          const candidate = await approvePlugin(body.target, body.reviewToken)
          const existing = await Plugin.get(body.target.pluginId)
          const persisted = (await readApprovals()).some(
            (approval) =>
              approval.pluginId === candidate.pluginId &&
              approval.status === "approved" &&
              approval.manifestHash === candidate.manifestHash &&
              approval.capabilitiesHash === candidate.capabilitiesHash,
          )
          if (existing && persisted) {
            const status = await Plugin.getStatus(body.target.pluginId)
            return context.json(status ?? { approved: true })
          }
          await PluginInstallationTransaction.approve({
            pluginId: body.target.pluginId,
            approval: () => approvePlugin(body.target, body.reviewToken),
            reload,
            getLoaded: async () => getLoadedPlugins(),
          })
          const status = await Plugin.getStatus(body.target.pluginId)
          return context.json(status ?? { approved: true })
        }

        if (body.target.kind === "registry") {
          const approval = await approvePlugin(body.target, body.reviewToken)
          const { spec, source } = await resolveRegistrySpec(
            body.target.pluginId,
            body.target.version,
            body.target.source,
          )
          const plugin = await Plugin.add(spec, { autoReload: true, source, preApproved: approval })
          return context.json({ ...(await Plugin.getStatus(plugin.id)), manifest: plugin.manifest })
        }
      } catch (err) {
        if (err instanceof ApprovalStaleReviewError)
          return context.json({ code: err.code, message: err.message, review: err.review }, 409)
        if (err instanceof ApprovalPluginNotFoundError)
          return context.json({ code: err.code, message: err.message }, 404)
        if (err instanceof ApprovalInvalidError) return context.json({ code: err.code, message: err.message }, 422)
        throw err
      }
    },
  )
  .post(
    "/registry/install",
    describeRoute({
      operationId: "api.plugins.installFromRegistry",
      responses: {
        200: { description: "Installed" },
        409: {
          description: "Approval required",
          content: { "application/json": { schema: resolver(ApprovalReviewErrorSchema) } },
        },
        422: { description: "Invalid", content: { "application/json": { schema: resolver(StructuredErrorSchema) } } },
      },
    }),
    validator("json", z.object({ id: z.string(), version: z.string(), source: z.enum(["official", "local"]) })),
    async (context) => {
      const body = context.req.valid("json")
      try {
        const { spec, source } = await resolveRegistrySpec(body.id, body.version, body.source)
        const plugin = await Plugin.add(spec, { autoReload: true, source })
        const status = await Plugin.getStatus(plugin.id)
        return context.json({ ...status, manifest: plugin.manifest })
      } catch (err) {
        if (err instanceof PluginApprovalRequiredError) {
          try {
            const review = await buildApprovalReview({
              kind: "registry",
              pluginId: body.id,
              version: body.version,
              source: body.source,
            })
            return context.json({ code: err.code, message: err.message, review }, 409)
          } catch (reviewErr) {
            if (reviewErr instanceof ApprovalPluginNotFoundError)
              return context.json({ code: reviewErr.code, message: reviewErr.message }, 404)
            throw reviewErr
          }
        }
        if (err instanceof ApprovalPluginNotFoundError)
          return context.json({ code: err.code, message: err.message }, 422)
        throw err
      }
    },
  )
  .post(
    "/registry/update",
    describeRoute({
      operationId: "api.plugins.updateFromRegistry",
      responses: {
        200: { description: "Updated" },
        409: {
          description: "Approval required",
          content: { "application/json": { schema: resolver(ApprovalReviewErrorSchema) } },
        },
        422: { description: "Invalid", content: { "application/json": { schema: resolver(StructuredErrorSchema) } } },
      },
    }),
    validator("json", z.object({ pluginId: z.string(), version: z.string(), source: z.enum(["official", "local"]) })),
    async (context) => {
      const body = context.req.valid("json")
      try {
        const { spec, source } = await resolveRegistrySpec(body.pluginId, body.version, body.source)
        const plugin = await Plugin.add(spec, { autoReload: true, source })
        const status = await Plugin.getStatus(plugin.id)
        return context.json({ ...status, manifest: plugin.manifest })
      } catch (err) {
        if (err instanceof PluginApprovalRequiredError) {
          try {
            const review = await buildApprovalReview({
              kind: "registry",
              pluginId: body.pluginId,
              version: body.version,
              source: body.source,
            })
            return context.json({ code: err.code, message: err.message, review }, 409)
          } catch (reviewErr) {
            if (reviewErr instanceof ApprovalPluginNotFoundError)
              return context.json({ code: reviewErr.code, message: reviewErr.message }, 404)
            throw reviewErr
          }
        }
        if (err instanceof ApprovalPluginNotFoundError)
          return context.json({ code: err.code, message: err.message }, 422)
        throw err
      }
    },
  )
