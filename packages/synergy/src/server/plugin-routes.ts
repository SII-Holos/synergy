import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import path from "path"
import * as fs from "fs"
import { errors } from "./error"
import { Plugin } from "../plugin/index"
import { Config } from "../config/config"
import { Global } from "../global"
import type { PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"

// ── Helpers ──

/** Determine trust tier from pluginDir: local paths = trusted, cached npm = sandbox. */
function determineTrustTier(pluginDir: string): "trusted" | "sandbox" {
  const cacheRoot = Global.Path.cache
  const relative = path.relative(cacheRoot, pluginDir)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "trusted"
  }
  return "sandbox"
}

/**
 * Path containment check matching the pattern from asset.ts.
 * Returns the resolved absolute path if contained, null if traversal detected.
 */
function checkPathContainment(base: string, filePath: string): string | null {
  const resolved = path.resolve(base, filePath)
  const relative = path.relative(base, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null
  }
  return resolved
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
const ALLOWED_ASSET_DIRS = new Set(["dist", "public", "assets"])

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
    trustTier: z.enum(["trusted", "sandbox"]),
    ui: z.record(z.string(), z.any()).optional().nullable(),
    permissions: z.record(z.string(), z.any()).optional().nullable(),
  })
  .meta({ ref: "PluginUIContribution" })

const PluginStatus = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    version: z.string().optional(),
    source: z.enum(["local", "npm", "git", "url", "builtin", "official"]),
    trust: z.object({
      tier: z.enum(["declarative", "trusted-import", "sandbox"]),
      source: z.enum(["local", "npm", "git", "url", "builtin", "official"]),
      userTrusted: z.boolean(),
      verifiedIntegrity: z.boolean(),
      reason: z.string(),
    }),
    loaded: z.boolean(),
    loadError: z.string().optional(),
    manifestValid: z.boolean(),
    integrity: z.enum(["verified", "unverified", "failed"]),
    permissions: z.object({
      base: z.array(z.string()),
      tools: z.record(z.string(), z.array(z.string())),
      overallRisk: z.enum(["low", "medium", "high"]),
      warnings: z.array(
        z.object({
          type: z.string(),
          message: z.string(),
          toolId: z.string().optional(),
        }),
      ),
    }),
    routes: z.array(z.string()),
    tools: z.array(
      z.object({
        id: z.string(),
        fullId: z.string(),
        capabilities: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
    ),
    ui: z.object({
      contributions: z.number(),
      errors: z.array(z.string()),
    }),
    stores: z.object({
      config: z.boolean(),
      secrets: z.enum(["none", "plaintext", "keychain"]),
      cacheBytes: z.number().optional(),
    }),
    warnings: z.array(
      z.object({
        type: z.string(),
        message: z.string(),
        toolId: z.string().optional(),
      }),
    ),
  })
  .meta({ ref: "PluginStatus" })

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
      const loaded = await Plugin.loaded()
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
            trustTier: determineTrustTier(p.pluginDir),
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
      const config = await Config.get()
      const current = (config.pluginConfig?.[pluginId] as Record<string, any>) ?? {}
      const merged = { ...current, ...values }
      await Config.updateGlobal({ pluginConfig: { [pluginId]: merged } } as any)
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
    trustTier: z.enum(["trusted", "sandbox"]),
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
    trustTier: z.enum(["trusted", "sandbox"]),
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
      const loaded = await Plugin.loaded()
      const infos = loaded.map((p) => ({
        pluginId: p.id,
        name: p.name,
        version: undefined as string | undefined,
        trustTier: determineTrustTier(p.pluginDir),
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
        trustTier: determineTrustTier(plugin.pluginDir),
        hasManifest: manifest !== null,
        pluginDir: plugin.pluginDir,
        manifest: manifest ?? null,
        cliCommands: plugin.cli ? Object.keys(plugin.cli) : [],
        skills: plugin.skills ? plugin.skills.map((s) => s.name) : [],
        agents: plugin.agents ? Object.keys(plugin.agents) : [],
      })
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
