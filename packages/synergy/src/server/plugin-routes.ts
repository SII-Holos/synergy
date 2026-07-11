import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Plugin } from "../plugin"
import { riskForCapabilities } from "../plugin/capability"
import { getPluginConfig, replacePluginConfig } from "../plugin/config-store"
import {
  computeManifestHash,
  computePermissionsHash,
  getApproval,
  saveApproval,
} from "../plugin/consent/approval-store"
import { diffPermissions } from "../plugin/consent/diff"
import { PluginApprovalRequiredError } from "../plugin/install"
import { localRegistryPath, resolveLocalRegistryInstallSpec } from "../plugin/local-registry-store"
import { PluginMarketplaceRegistry } from "../plugin/marketplace-registry"
import { invokePluginOperation, PluginOperationError } from "../plugin/operation"
import { reloadDevelopmentGeneration } from "../plugin/loader"
import { PluginStatusSchema } from "../plugin/status"
import { isPathContained } from "../util/path-contain"
import { errors } from "./error"
import { ScopeContext } from "../scope/context"

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
const ApprovalBody = z.object({
  pluginId: z.string(),
  manifest: JsonValue,
  capabilities: z.array(z.string()),
  source: z.enum(["local", "official", "npm", "git", "url", "builtin"]),
})

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
  if (code === "CAPABILITY_DENIED" || code === "PLUGIN_DISABLED") return 403
  if (code === "TIMEOUT" || code === "CANCELLED") return 408
  if (code === "CONFLICT") return 409
  if (code === "PLUGIN_UNAVAILABLE") return 503
  return 400
}

async function installSpec(id: string, version: string, source: "official" | "local") {
  if (source === "official") {
    const artifact = await PluginMarketplaceRegistry.verifyOfficialArtifact(id, version)
    return { spec: pathToFileURL(artifact.tarballPath).href, source }
  }
  const registry = JSON.parse(await Bun.file(localRegistryPath()).text()) as {
    plugins?: Array<Record<string, unknown>>
  }
  const entry = registry.plugins?.find((item) => item.id === id)
  if (!entry) throw new Error(`Local registry plugin not found: ${id}`)
  const versions = Array.isArray(entry.versions) ? entry.versions : []
  const target = versions.find(
    (item) => item && typeof item === "object" && (item as Record<string, unknown>).version === version,
  )
  if (!target) throw new Error(`Local registry plugin version not found: ${id}@${version}`)
  return { spec: resolveLocalRegistryInstallSpec(entry, target), source }
}

async function approvalRequired(error: PluginApprovalRequiredError, source: string) {
  const oldManifest = await Plugin.manifest(error.pluginId)
  const oldCapabilities = oldManifest?.capabilities.map((item) => item.id) ?? []
  return {
    code: error.code,
    message: error.message,
    pluginId: error.pluginId,
    version: error.version,
    source,
    manifest: error.manifest,
    capabilities: error.capabilities,
    risk: error.risk,
    diff: diffPermissions(error.pluginId, oldManifest, error.manifest, oldCapabilities, error.capabilities),
  }
}

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
      if (!(await Plugin.get(context.req.param("pluginId")))) return context.json({ message: "Plugin not found" }, 404)
      return context.json(await getPluginConfig(context.req.param("pluginId")))
    },
  )
  .patch(
    "/:pluginId/config",
    describeRoute({
      operationId: "plugin.updateConfig",
      responses: { 200: { description: "Plugin settings" }, ...errors(404) },
    }),
    validator("json", z.record(z.string(), z.unknown())),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      if (!plugin) return context.json({ message: "Plugin not found" }, 404)
      return context.json(
        await replacePluginConfig(plugin.id, context.req.valid("json"), { manifest: plugin.manifest }),
      )
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
  .post(
    "/approve-install",
    describeRoute({ operationId: "api.plugins.approveInstall", responses: { 200: { description: "Approved" } } }),
    validator("json", ApprovalBody),
    async (context) => {
      const body = context.req.valid("json")
      const manifest = PluginManifest.parse(body.manifest)
      if (manifest.id !== body.pluginId) return context.json({ message: "Manifest plugin id mismatch" }, 400)
      const declared = manifest.capabilities.map((item) => item.id)
      if (JSON.stringify([...declared].sort()) !== JSON.stringify([...body.capabilities].sort()))
        return context.json({ message: "Capability list mismatch" }, 400)
      const trusted = manifest.contributions.some(
        (item) => item.kind.startsWith("ui.") && "component" in item && Boolean(item.component),
      )
      await saveApproval({
        pluginId: manifest.id,
        source: body.source,
        version: manifest.version,
        manifestHash: computeManifestHash(manifest),
        capabilitiesHash: computePermissionsHash(manifest, declared),
        approvedAt: Date.now(),
        approvedBy: "user",
        trustTier: trusted ? "trusted-import" : "declarative",
        approvedCapabilities: declared,
        risk: riskForCapabilities(declared),
        status: "approved",
      })
      return context.json({ approved: true })
    },
  )
  .get(
    "/:pluginId/approval",
    describeRoute({
      operationId: "api.plugins.getApproval",
      responses: { 200: { description: "Approval" }, ...errors(404) },
    }),
    async (context) => {
      const plugin = await Plugin.get(context.req.param("pluginId"))
      const approval = await getApproval(context.req.param("pluginId"), plugin?.manifest)
      return approval ? context.json(approval) : context.json({ message: "Approval not found" }, 404)
    },
  )
  .post(
    "/registry/install",
    describeRoute({
      operationId: "api.plugins.installFromRegistry",
      responses: { 200: { description: "Installed" }, 409: { description: "Approval required" } },
    }),
    validator("json", z.object({ id: z.string(), version: z.string(), source: z.enum(["official", "local"]) })),
    async (context) => {
      const body = context.req.valid("json")
      const target = await installSpec(body.id, body.version, body.source)
      try {
        const plugin = await Plugin.add(target.spec, { autoReload: true, source: target.source })
        return context.json({ ...(await Plugin.getStatus(plugin.id)), manifest: plugin.manifest })
      } catch (error) {
        if (error instanceof PluginApprovalRequiredError)
          return context.json(await approvalRequired(error, body.source), 409)
        throw error
      }
    },
  )
  .post(
    "/registry/update",
    describeRoute({
      operationId: "api.plugins.updateFromRegistry",
      responses: { 200: { description: "Updated" }, 409: { description: "Approval required" } },
    }),
    validator("json", z.object({ pluginId: z.string(), version: z.string(), source: z.enum(["official", "local"]) })),
    async (context) => {
      const body = context.req.valid("json")
      const target = await installSpec(body.pluginId, body.version, body.source)
      try {
        const plugin = await Plugin.add(target.spec, { autoReload: true, source: target.source })
        return context.json({ ...(await Plugin.getStatus(plugin.id)), manifest: plugin.manifest })
      } catch (error) {
        if (error instanceof PluginApprovalRequiredError)
          return context.json(await approvalRequired(error, body.source), 409)
        throw error
      }
    },
  )
