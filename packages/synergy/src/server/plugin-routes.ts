import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import path from "path"
import * as fs from "fs"
import { pathToFileURL } from "url"
import { errors } from "./error"
import { defaultPluginTrustDecision, derivePluginSource, type PluginTrustDecision } from "../plugin/trust"
import { Installation } from "../global/installation"
import { Plugin } from "../plugin/index"
import { Config } from "../config/config"
import type { PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"

import { diffPermissions } from "../plugin/consent/diff"
import { computeRisk } from "../plugin/consent/risk"
import {
  saveApproval,
  getApproval,
  computeManifestHash,
  computePermissionsHash,
  verifyApproval,
} from "../plugin/consent/approval-store"
import type { PluginApprovalRecord } from "../plugin/consent/approval-store"
import { baseCapabilities } from "../plugin/capability"
import { checkPathContainment } from "../util/path-contain"
import { PluginMarketplaceRegistry } from "../plugin/marketplace-registry"
import { localRegistryPath } from "../plugin/local-registry-store"

import { PluginStatusSchema } from "../plugin/status.js"

function getPluginTrust(pluginDir: string): PluginTrustDecision {
  const source = derivePluginSource(pluginDir)
  return defaultPluginTrustDecision({
    source,
    verifiedIntegrity: false, // routes don't have integrity context
    devMode: Installation.isLocal(),
  })
}

// ── Asset security ──

const MIME_MAP: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
}

/** Directories that plugins are allowed to serve static files from. */
const ALLOWED_ASSET_DIRS = new Set(["dist", "public", "assets", "ui", "themes", "icons"])

/** Check that the relative path starts within an allowed asset root. */
function isAllowedAssetDir(relative: string): boolean {
  const firstSegment = relative.split(path.sep)[0]
  return firstSegment !== undefined && ALLOWED_ASSET_DIRS.has(firstSegment)
}

/** Derive a MIME type from a file path extension, with a safe fallback. */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_MAP[ext] ?? "application/octet-stream"
}

/** Strip dangerous elements/attributes from SVG content. */
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<script[\s\S]*?\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/<foreignObject[\s\S]*?\/>/gi, "")
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\shref\s*=\s*["'](?:https?:|javascript:)[^"']*["']/gi, ' href=""')
}

// ── Response schemas ──

const UIContribution = z
  .object({
    pluginId: z.string(),
    name: z.string().optional(),
    version: z.string(),
    trustTier: z.enum(["declarative", "trusted-import", "sandbox"]),
    ui: z.record(z.string(), z.any()).optional().nullable(),
    permissions: z.record(z.string(), z.any()).optional().nullable(),
  })
  .meta({ ref: "PluginUIContribution" })

const PluginStatus = PluginStatusSchema

function apiPluginDetail(loadedPlugin: Plugin.LoadedPlugin, manifest: PluginManifestType | null) {
  return {
    pluginId: loadedPlugin.id,
    name: loadedPlugin.name ?? manifest?.name,
    version: manifest?.version ?? "0.0.0",
    trustTier: getPluginTrust(loadedPlugin.pluginDir).tier,
    hasManifest: manifest !== null,
    pluginDir: loadedPlugin.pluginDir,
    manifest: manifest ?? null,
    cliCommands: loadedPlugin.cli ? Object.keys(loadedPlugin.cli) : [],
    skills: loadedPlugin.skills ? loadedPlugin.skills.map((s: any) => s.name) : [],
    agents: loadedPlugin.agents ? Object.keys(loadedPlugin.agents) : [],
  }
}

async function manifestFor(pluginId: string): Promise<PluginManifestType | null> {
  try {
    return await Plugin.manifest(pluginId)
  } catch {
    return null
  }
}

async function installOfficialRegistryPlugin(id: string, version: string) {
  const artifact = await PluginMarketplaceRegistry.verifyOfficialArtifact(id, version)
  const approval = await getApproval(id)
  if (!approval || !verifyApproval(approval, artifact.manifest, artifact.capabilities)) {
    const oldManifest = await manifestFor(id)
    const oldCapabilities = oldManifest ? baseCapabilities(oldManifest) : []
    const diff = diffPermissions(id, oldManifest, artifact.manifest, oldCapabilities, artifact.capabilities)
    return {
      type: "approval_required" as const,
      body: {
        code: "approval_required",
        message: `Plugin ${id}@${version} requires approval before installation.`,
        source: "official",
        pluginId: id,
        version,
        manifest: artifact.manifest,
        capabilities: artifact.capabilities,
        risk: artifact.risk,
        diff,
        artifactCacheKey: artifact.cacheKey,
      },
    }
  }

  const loadedPlugin = await Plugin.add(pathToFileURL(artifact.tarballPath).href, {
    autoReload: true,
    skipConsent: true,
  })
  const manifest = await manifestFor(loadedPlugin.id)
  return { type: "installed" as const, body: apiPluginDetail(loadedPlugin, manifest) }
}

// ── Route group ──

export const PluginRoute = new Hono()

  // 1. GET /ui/contributions — Aggregated UI manifests for all loaded plugins
  .get(
    "/ui/contributions",
    describeRoute({
      summary: "List plugin UI contributions",
      description: "Return aggregated UI manifests for all loaded plugins.",
      operationId: "plugin.listUIContributions",
      responses: {
        200: {
          description: "List of plugin UI contributions",
          content: {
            "application/json": { schema: resolver(UIContribution.array()) },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const loaded = await Plugin.getLoaded()
      const contributions = await Promise.all(
        loaded.map(async (p) => {
          let manifest: PluginManifestType | null = null
          try {
            manifest = await Plugin.manifest(p.id)
          } catch {
            // plugin has no valid manifest — omit manifest fields
          }
          return {
            pluginId: p.id,
            name: p.name ?? manifest?.name,
            version: manifest?.version ?? "0.0.0",
            trustTier: getPluginTrust(p.pluginDir).tier,
            ui: manifest?.contributes?.ui ?? null,
            permissions: manifest?.permissions ?? null,
          }
        }),
      )
      return c.json(contributions)
    },
  )

  // 2. GET /assets/:pluginId/:versionHash/* — Serve plugin static files with immutable cache
  .get(
    "/assets/:pluginId/:versionHash/*",
    describeRoute({
      summary: "Serve plugin static asset",
      description: "Serve a static file from a plugin's directory with immutable cache headers.",
      operationId: "plugin.serveAsset",
      responses: {
        200: { description: "Plugin static asset" },
        ...errors(400, 404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const versionHash = c.req.param("versionHash")
      const filePath = c.req.param("*")
      if (!filePath) return c.json({ message: "Missing asset path" }, 400)

      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)
      const pluginDir = plugin.pluginDir

      // 1. Path containment — prevent directory traversal
      const resolved = checkPathContainment(pluginDir, filePath)
      if (!resolved) {
        return c.json({ message: "Path traversal denied" }, 403)
      }

      // 2. Symlink realpath containment
      let real: string
      try {
        real = await fs.promises.realpath(resolved)
      } catch {
        return c.json({ message: `Asset not found: ${filePath}` }, 404)
      }
      const realRelative = path.relative(pluginDir, real)
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        return c.json({ message: "Path traversal denied" }, 403)
      }

      // 3. Allowed directories restriction
      if (!isAllowedAssetDir(realRelative)) {
        return c.json({ message: "Asset directory not allowed" }, 403)
      }

      // 4. Cache headers — immutable for version-hashed assets, shorter for others
      const cacheControl =
        versionHash && versionHash !== "latest" ? "public, immutable, max-age=31536000" : "public, max-age=3600"
      c.header("Cache-Control", cacheControl)

      // 5. MIME enforcement from our known map
      const mimeType = getMimeType(filePath)

      // 6. SVG sanitization — read, sanitize, serve as text
      const ext = path.extname(filePath).toLowerCase()
      if (ext === ".svg") {
        const raw = await Bun.file(real).text()
        const sanitized = sanitizeSvg(raw)
        return c.body(sanitized, { headers: { "Content-Type": mimeType } })
      }

      return c.body(Bun.file(real).stream(), { headers: { "Content-Type": mimeType } })
    },
  )

  // 3. GET /:pluginId/sandbox/:panelId — Serve sandbox HTML shell for iframe panels
  .get(
    "/:pluginId/sandbox/:panelId",
    describeRoute({
      summary: "Serve plugin sandbox iframe shell",
      description: "Serve an HTML shell for loading a plugin panel in a sandboxed iframe.",
      operationId: "plugin.sandbox",
      responses: {
        200: { description: "Sandbox HTML page" },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const panelId = c.req.param("panelId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      const manifest = await Plugin.manifest(pluginId)
      const ui = manifest?.contributes?.ui
      const version = manifest?.version ?? "0.0.0"

      // Resolve entry: panel-level sandboxEntry > ui.entry > default
      const panels = [...(ui?.workspacePanels ?? []), ...(ui?.globalPanels ?? [])]
      const panel = panels.find((p) => p.id === panelId)
      const entry = panel?.sandboxEntry ?? ui?.entry ?? "dist/ui.js"

      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; font-family: system-ui; background: var(--bg); color: var(--fg); }
  </style>
</head>
<body>
  <script src="/plugin/assets/${pluginId}/${version}/${entry}"></script>
</body>
</html>`
      return c.html(html)
    },
  )

  // 4. POST /:pluginId/interact — PostMessage bridge relay
  .post(
    "/:pluginId/interact",
    describeRoute({
      summary: "Relay plugin interaction",
      description: "Relay a postMessage interaction for a plugin.",
      operationId: "plugin.interact",
      responses: {
        200: {
          description: "Interaction relayed",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ status: z.string(), type: z.string() }).meta({ ref: "PluginInteractResult" }),
              ),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator(
      "json",
      z.object({
        type: z.string().min(1),
        payload: z.any().optional(),
        source: z.string().optional(),
      }),
    ),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      const body = c.req.valid("json")
      return c.json({ status: "received", type: body.type })
    },
  )

  // 5. GET /:pluginId/config-schema — Plugin's contributed config schema
  .get(
    "/:pluginId/config-schema",
    describeRoute({
      summary: "Get plugin config schema",
      description: "Return the plugin's contributed config schema from its manifest.",
      operationId: "plugin.configSchema",
      responses: {
        200: {
          description: "Plugin config schema",
          content: {
            "application/json": {
              schema: resolver(z.record(z.string(), z.any()).meta({ ref: "PluginConfigSchema" })),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const manifest = await Plugin.manifest(pluginId)
      if (!manifest) return c.json({ message: `Plugin manifest not found: ${pluginId}` }, 404)

      const schema = manifest.contributes?.config?.schema ?? {}
      return c.json(schema)
    },
  )

  // 5a. GET /:pluginId/config — Read plugin config
  .get(
    "/:pluginId/config",
    describeRoute({
      summary: "Get plugin config",
      description: "Return the current config values for a plugin.",
      operationId: "plugin.getConfig",
      responses: {
        200: {
          description: "Plugin config",
          content: {
            "application/json": {
              schema: resolver(z.record(z.string(), z.any()).meta({ ref: "PluginConfig" })),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      const config = await Config.current()
      const values = (config.pluginConfig?.[pluginId] as Record<string, any>) ?? {}
      return c.json(values)
    },
  )
  // 6. PATCH /:pluginId/config — Update plugin config
  .patch(
    "/:pluginId/config",
    describeRoute({
      summary: "Update plugin config",
      description: "Merge values into the plugin's configuration namespace.",
      operationId: "plugin.updateConfig",
      responses: {
        200: {
          description: "Updated plugin config",
          content: {
            "application/json": {
              schema: resolver(z.record(z.string(), z.any()).meta({ ref: "PluginConfig" })),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    // TODO: Future — enforce against manifest.contributes.config.schema per-plugin
    validator(
      "json",
      z
        .record(z.string(), z.any())
        .refine((obj) => JSON.stringify(obj).length < 65536, { message: "Config payload too large (max 64KB)" }),
    ),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      const values = c.req.valid("json")
      const config = await Config.current()
      const current = (config.pluginConfig?.[pluginId] as Record<string, any>) ?? {}
      const merged = { ...current, ...values }
      await Config.domainUpdate("plugins", { pluginConfig: { [pluginId]: merged } } as any)
      return c.json(merged)
    },
  )

  // 7. GET /:pluginId/status — Report plugin status
  .get(
    "/:pluginId/status",
    describeRoute({
      summary: "Get plugin status",
      description: "Report the current status of a loaded plugin.",
      operationId: "plugin.status",
      responses: {
        200: {
          description: "Plugin status",
          content: {
            "application/json": { schema: resolver(PluginStatus) },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const status = await Plugin.getStatus(pluginId)
      if (!status) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      return c.json(status)
    },
  )

// ── API plugin route group (mounted at /api/plugins) ──

const ApiPluginInfo = z
  .object({
    pluginId: z.string(),
    name: z.string().optional(),
    version: z.string().optional(),
    trustTier: z.enum(["declarative", "trusted-import", "sandbox"]),
    hasManifest: z.boolean(),
    pluginDir: z.string(),
    cliCommands: z.array(z.string()),
    skillCount: z.number(),
    agentCount: z.number(),
  })
  .meta({ ref: "ApiPluginInfo" })

const ApiPluginDetail = z
  .object({
    pluginId: z.string(),
    name: z.string().optional(),
    version: z.string().optional(),
    trustTier: z.enum(["declarative", "trusted-import", "sandbox"]),
    hasManifest: z.boolean(),
    pluginDir: z.string(),
    manifest: z.record(z.string(), z.any()).optional().nullable(),
    cliCommands: z.array(z.string()),
    skills: z.array(z.string()),
    agents: z.array(z.string()),
  })
  .meta({ ref: "ApiPluginDetail" })

export const ApiPluginRoute = new Hono()

  // GET / — List all loaded plugins
  .get(
    "/",
    describeRoute({
      summary: "List all loaded plugins",
      description: "Return metadata for all currently loaded plugins.",
      operationId: "api.plugins.list",
      responses: {
        200: {
          description: "List of loaded plugins",
          content: {
            "application/json": { schema: resolver(ApiPluginInfo.array()) },
          },
        },
      },
    }),
    async (c) => {
      const loaded = await Plugin.getLoaded()
      const infos = loaded.map((p) => ({
        pluginId: p.id,
        name: p.name,
        version: undefined as string | undefined,
        trustTier: getPluginTrust(p.pluginDir).tier,
        hasManifest: false,
        pluginDir: p.pluginDir,
        cliCommands: p.cli ? Object.keys(p.cli) : [],
        skillCount: p.skills?.length ?? 0,
        agentCount: p.agents ? Object.keys(p.agents).length : 0,
      }))
      // Enrich with manifest version and hasManifest
      await Promise.all(
        infos.map(async (info) => {
          try {
            const m = await Plugin.manifest(info.pluginId)
            if (m) {
              info.version = m.version
              info.hasManifest = true
            } else {
              info.version = "0.0.0"
            }
          } catch {
            info.version = "0.0.0"
          }
        }),
      )
      return c.json(infos)
    },
  )

  // GET /:pluginId — Get single plugin info
  .get(
    "/:pluginId",
    describeRoute({
      summary: "Get plugin detail",
      description: "Return detailed metadata for a single loaded plugin.",
      operationId: "api.plugins.get",
      responses: {
        200: {
          description: "Plugin detail",
          content: {
            "application/json": { schema: resolver(ApiPluginDetail) },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      let manifest: PluginManifestType | null = null
      try {
        manifest = await Plugin.manifest(pluginId)
      } catch {
        // no-op
      }

      return c.json({
        pluginId: plugin.id,
        name: plugin.name ?? manifest?.name,
        version: manifest?.version ?? "0.0.0",
        trustTier: getPluginTrust(plugin.pluginDir).tier,
        hasManifest: manifest !== null,
        pluginDir: plugin.pluginDir,
        manifest: manifest ?? null,
        cliCommands: plugin.cli ? Object.keys(plugin.cli) : [],
        skills: plugin.skills ? plugin.skills.map((s) => s.name) : [],
        agents: plugin.agents ? Object.keys(plugin.agents) : [],
      })
    },
  )

  // DELETE /:pluginId — Uninstall and deactivate a plugin
  .delete(
    "/:pluginId",
    describeRoute({
      summary: "Remove plugin",
      description: "Uninstall and deactivate a plugin, then reload the plugin runtime.",
      operationId: "api.plugins.remove",
      responses: {
        200: {
          description: "Plugin removed",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  pluginId: z.string(),
                  removed: z.literal(true),
                }),
              ),
            },
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
        await Plugin.remove(pluginId, { autoReload: true })
        return c.json({ pluginId, removed: true as const })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ message: `Remove failed: ${message}` }, 500)
      }
    },
  )

  // GET /:pluginId/status — Comprehensive plugin status
  .get(
    "/:pluginId/status",
    describeRoute({
      summary: "Get plugin status",
      description: "Report the current status of a loaded plugin.",
      operationId: "api.plugins.status",
      responses: {
        200: {
          description: "Plugin status",
          content: {
            "application/json": { schema: resolver(PluginStatus) },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const status = await Plugin.getStatus(pluginId)
      if (!status) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      return c.json(status)
    },
  )

  // ── Consent routes ──

  // POST /preview-install — Compute permission diff for a new plugin manifest
  .post(
    "/preview-install",
    describeRoute({
      summary: "Preview permissions for new plugin install",
      description: "Compute the permission diff for a new plugin manifest before installation.",
      operationId: "api.plugins.previewInstall",
      responses: {
        200: {
          description: "Permission diff",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.any())) },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        manifest: z.record(z.string(), z.any()),
      }),
    ),
    async (c) => {
      const { manifest } = c.req.valid("json")
      const pluginId = (manifest.name as string) ?? "unknown"
      const caps = baseCapabilities(manifest as PluginManifestType)
      const diff = diffPermissions(pluginId, null, manifest as PluginManifestType, [], caps)
      return c.json(diff)
    },
  )

  // POST /:pluginId/approve-install — Record install approval
  .post(
    "/:pluginId/approve-install",
    describeRoute({
      summary: "Approve new plugin install",
      description: "Record approval for a new plugin installation after reviewing its permissions.",
      operationId: "api.plugins.approveInstall",
      responses: {
        200: {
          description: "Approval record",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.any())) },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "json",
      z.object({
        manifest: z.record(z.string(), z.any()),
        capabilities: z.array(z.string()),
        source: z.enum(["local", "official", "npm", "git", "url", "builtin"]).optional(),
      }),
    ),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      const { manifest, capabilities, source: approvedSource } = c.req.valid("json")
      const m = manifest as PluginManifestType
      if (m.name !== pluginId) {
        return c.json(
          { message: `Plugin identity mismatch: URL id "${pluginId}" does not match manifest name "${m.name}"` },
          400,
        )
      }
      const source = approvedSource ?? (plugin ? derivePluginSource(plugin.pluginDir) : "local")
      const risk = computeRisk(capabilities, m)
      const record: PluginApprovalRecord = {
        pluginId,
        source,
        version: m.version ?? "0.0.0",
        manifestHash: computeManifestHash(m),
        permissionsHash: computePermissionsHash(m, capabilities),
        approvedAt: Date.now(),
        approvedBy: "user",
        trustTier: "trusted-import",
        approvedCapabilities: capabilities,
        approvedNetworkDomains: m.permissions?.network?.connectDomains ?? [],
        approvedUISurfaces: [],
        risk,
      }
      await saveApproval(record)
      return c.json(record)
    },
  )

  // POST /:pluginId/preview-update — Compute diff between current and new manifest
  .post(
    "/:pluginId/preview-update",
    describeRoute({
      summary: "Preview permissions for plugin update",
      description: "Compute the permission diff between the currently installed plugin and a new manifest version.",
      operationId: "api.plugins.previewUpdate",
      responses: {
        200: {
          description: "Permission diff",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.any())) },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "json",
      z.object({
        manifest: z.record(z.string(), z.any()),
      }),
    ),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const { manifest } = c.req.valid("json")
      const newManifest = manifest as PluginManifestType
      const oldManifest = await Plugin.manifest(pluginId)
      if (!oldManifest) return c.json({ message: `Plugin not found or has no manifest: ${pluginId}` }, 404)
      const oldCaps = baseCapabilities(oldManifest)
      const newCaps = baseCapabilities(newManifest)
      const diff = diffPermissions(pluginId, oldManifest, newManifest, oldCaps, newCaps)
      return c.json(diff)
    },
  )

  // POST /:pluginId/approve-update — Record update approval (overwrites previous)
  .post(
    "/:pluginId/approve-update",
    describeRoute({
      summary: "Approve plugin update",
      description: "Record approval for a plugin update after reviewing its permission changes.",
      operationId: "api.plugins.approveUpdate",
      responses: {
        200: {
          description: "Approval record",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.any())) },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        manifest: z.record(z.string(), z.any()),
        capabilities: z.array(z.string()),
        source: z.enum(["local", "official", "npm", "git", "url", "builtin"]).optional(),
      }),
    ),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const plugin = await Plugin.get(pluginId)
      const { manifest, capabilities, source: approvedSource } = c.req.valid("json")
      const m = manifest as PluginManifestType
      if (m.name !== pluginId) {
        return c.json(
          { message: `Plugin identity mismatch: URL id "${pluginId}" does not match manifest name "${m.name}"` },
          400,
        )
      }
      const source = approvedSource ?? (plugin ? derivePluginSource(plugin.pluginDir) : "local")
      const risk = computeRisk(capabilities, m)
      const record: PluginApprovalRecord = {
        pluginId,
        source,
        version: m.version ?? "0.0.0",
        manifestHash: computeManifestHash(m),
        permissionsHash: computePermissionsHash(m, capabilities),
        approvedAt: Date.now(),
        approvedBy: "user",
        trustTier: "trusted-import",
        approvedCapabilities: capabilities,
        approvedNetworkDomains: m.permissions?.network?.connectDomains ?? [],
        approvedUISurfaces: [],
        risk,
      }
      await saveApproval(record)
      return c.json(record)
    },
  )

  // GET /:pluginId/approval — Get current approval status
  .get(
    "/:pluginId/approval",
    describeRoute({
      summary: "Get plugin approval status",
      description: "Return the current approval record for a plugin, or 404 if not approved.",
      operationId: "api.plugins.getApproval",
      responses: {
        200: {
          description: "Approval record",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.any())) },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const approval = await getApproval(pluginId)
      if (!approval) return c.json({ message: `No approval record for plugin: ${pluginId}` }, 404)
      return c.json(approval)
    },
  )

  // GET /:pluginId/permission-diff — Get diff between current and target version
  .get(
    "/:pluginId/permission-diff",
    describeRoute({
      summary: "Get permission diff for plugin version",
      description: "Return the permission diff between the approved capabilities and the current plugin manifest.",
      operationId: "api.plugins.permissionDiff",
      responses: {
        200: {
          description: "Permission diff",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.any())) },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const currentManifest = await Plugin.manifest(pluginId)
      if (!currentManifest) return c.json({ message: `Plugin not found or has no manifest: ${pluginId}` }, 404)
      const approval = await getApproval(pluginId)
      const currentCaps = baseCapabilities(currentManifest)
      if (!approval) {
        const diff = diffPermissions(pluginId, null, currentManifest, [], currentCaps)
        return c.json(diff)
      }
      const approvedCaps = approval.approvedCapabilities
      const diff = diffPermissions(pluginId, currentManifest, currentManifest, approvedCaps, currentCaps)
      return c.json(diff)
    },
  )

  // ── Install from registry ──

  // POST /install-from-registry — Install a plugin from the registry
  .post(
    "/install-from-registry",
    describeRoute({
      summary: "Install plugin from registry",
      description:
        "Install a plugin from the official or local registry. Looks up the plugin and version in the registry, " +
        "then installs the version archive or package spec and loads it into the runtime.",
      operationId: "api.plugins.installFromRegistry",
      responses: {
        200: {
          description: "Install result with plugin status",
          content: {
            "application/json": { schema: resolver(ApiPluginDetail) },
          },
        },
        ...errors(400, 404, 409, 500),
      },
    }),
    validator(
      "json",
      z.object({
        id: z.string().min(1, "Plugin ID is required"),
        version: z.string().min(1, "Version is required"),
        source: PluginMarketplaceRegistry.Source.optional(),
      }),
    ),
    async (c) => {
      const { id, version, source } = c.req.valid("json")

      if (source !== "local") {
        try {
          const result = await installOfficialRegistryPlugin(id, version)
          if (result.type === "approval_required") return c.json(result.body, 409)
          return c.json(result.body)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const canFallbackLocal =
            source === undefined &&
            (message.includes("Official registry plugin not found") ||
              message.includes("Official registry version not found") ||
              message.includes("public plugin marketplace"))
          if (!canFallbackLocal) {
            return c.json({ message: `Install failed: ${message}` }, 500)
          }
        }
      }

      // Load registry to find the plugin entry
      const registryPath = localRegistryPath()
      let plugins: any[]
      try {
        const file = Bun.file(registryPath)
        const exists = await file.exists()
        if (!exists) return c.json({ message: "Registry is empty" }, 404)
        const text = await file.text()
        const parsed = JSON.parse(text)
        plugins = Array.isArray(parsed) ? parsed : (parsed.plugins ?? [])
      } catch {
        return c.json({ message: "Failed to read registry" }, 500)
      }

      const entry = plugins.find((p: any) => p.id === id)
      if (!entry) return c.json({ message: `Plugin not found in registry: ${id}` }, 404)

      const targetVersion = entry.versions?.find((v: any) => v.version === version)
      if (!targetVersion) return c.json({ message: `Version not found in registry: ${id}@${version}` }, 404)

      const spec = targetVersion.downloadUrl ?? entry.name ?? id
      let loadedPlugin: Plugin.LoadedPlugin
      try {
        loadedPlugin = await Plugin.add(spec, { autoReload: true })
      } catch (err: any) {
        const message = `Install failed: ${err?.message ?? String(err)}`
        if (message.includes("requires approval before installation")) {
          return c.json({ message }, 409)
        }
        return c.json(
          {
            message,
          },
          500,
        )
      }

      const manifest = await manifestFor(loadedPlugin.id)
      return c.json(apiPluginDetail(loadedPlugin, manifest))
    },
  )

  // POST /:pluginId/update-from-registry — Check for plugin updates from registry
  .post(
    "/:pluginId/update-from-registry",
    describeRoute({
      summary: "Check for plugin update from registry",
      description:
        "Check if an update is available for a plugin from the local registry. " +
        "Optionally target a specific version. Returns version comparison and permission diff.",
      operationId: "api.plugins.updateFromRegistry",
      responses: {
        200: {
          description: "Update check result",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.any())) },
          },
        },
        ...errors(400, 404, 500),
      },
    }),
    validator(
      "json",
      z.object({
        targetVersion: z.string().min(1).optional(),
      }),
    ),
    async (c) => {
      const pluginId = c.req.param("pluginId")
      const { targetVersion } = c.req.valid("json")

      // 1. Look up installed plugin
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      // 2. Get installed manifest for version
      const installedManifest = await Plugin.manifest(pluginId)
      const fromVersion = installedManifest?.version ?? "0.0.0"

      // 3. If targetVersion matches installed version, no update needed (short-circuit)
      if (targetVersion && targetVersion === fromVersion) {
        return c.json({
          pluginId,
          fromVersion,
          toVersion: fromVersion,
          updateAvailable: false,
          requiresConsent: false,
        })
      }

      // 4. Load registry
      const registryPath = localRegistryPath()
      let plugins: any[]
      try {
        const file = Bun.file(registryPath)
        const exists = await file.exists()
        if (!exists) {
          // No registry — return structured response indicating no update check possible
          return c.json({
            pluginId,
            fromVersion,
            toVersion: fromVersion,
            updateAvailable: false,
            requiresConsent: false,
          })
        }
        const text = await file.text()
        const parsed = JSON.parse(text)
        plugins = Array.isArray(parsed) ? parsed : (parsed.plugins ?? [])
      } catch {
        return c.json({ message: "Failed to read registry" }, 500)
      }

      // 5. Find registry entry for plugin
      const entry = plugins.find((p: any) => p.id === pluginId)
      if (!entry) {
        // Plugin not in registry — no update check possible
        return c.json({
          pluginId,
          fromVersion,
          toVersion: fromVersion,
          updateAvailable: false,
          requiresConsent: false,
        })
      }

      // 6. Determine target registry version
      let toVersion: string
      let registryVersion: any
      if (targetVersion) {
        registryVersion = entry.versions?.find((v: any) => v.version === targetVersion)
        if (!registryVersion)
          return c.json({ message: `Version not found in registry: ${pluginId}@${targetVersion}` }, 404)
        toVersion = registryVersion.version
      } else {
        const sorted = [...(entry.versions ?? [])].sort((a: any, b: any) =>
          a.version.localeCompare(b.version, undefined, { numeric: true }),
        )
        if (sorted.length === 0) {
          return c.json({
            pluginId,
            fromVersion,
            toVersion: fromVersion,
            updateAvailable: false,
            requiresConsent: false,
          })
        }
        registryVersion = sorted[sorted.length - 1]
        toVersion = registryVersion.version
      }

      // 7. Compare versions
      if (fromVersion === toVersion) {
        return c.json({
          pluginId,
          fromVersion,
          toVersion,
          updateAvailable: false,
          requiresConsent: false,
          registryVersion,
        })
      }

      // 8. Build response — update is available
      // Full permission diff requires the new manifest, which isn't stored in the registry.
      // Return structured response with registry version info and requiresConsent flag.
      const result: Record<string, any> = {
        pluginId,
        fromVersion,
        toVersion,
        updateAvailable: true,
        requiresConsent: true,
        registryVersion,
      }

      return c.json(result)
    },
  )
