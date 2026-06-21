import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import path from "path"
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
    pluginId: z.string(),
    loaded: z.boolean(),
    name: z.string().optional(),
    version: z.string().optional(),
    hasManifest: z.boolean(),
    trustTier: z.enum(["trusted", "sandbox"]),
    manifest: z.record(z.string(), z.any()).optional().nullable(),
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
      const filePath = c.req.param("*")
      if (!filePath) return c.json({ message: "Missing asset path" }, 400)
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      const resolved = checkPathContainment(plugin.pluginDir, filePath)
      if (!resolved) {
        return c.json({ message: "Path traversal denied" }, 400)
      }

      const file = Bun.file(resolved)
      if (!(await file.exists())) {
        return c.json({ message: `Asset not found: ${filePath}` }, 404)
      }

      c.header("Cache-Control", "public, immutable, max-age=31536000")
      return c.body(file.stream(), {
        headers: { "Content-Type": file.type || "application/octet-stream" },
      })
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

      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${plugin.name ?? pluginId} — ${panelId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    #root { height: 100%; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    const PLUGIN_ID = ${JSON.stringify(pluginId)};
    const PANEL_ID = ${JSON.stringify(panelId)};
    // Notify parent that sandbox is ready
    window.parent.postMessage({
      type: "synergy:plugin:ready",
      pluginId: PLUGIN_ID,
      panelId: PANEL_ID,
    }, "*")
    // Listen for messages from parent window
    window.addEventListener("message", (event) => {
      if (event.source === window.parent && event.data?.type?.startsWith("synergy:")) {
        // Forward parent messages to the plugin runtime
      }
    })
  </script>
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
    validator("json", z.record(z.string(), z.any())),
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
      const plugin = await Plugin.get(pluginId)
      if (!plugin) return c.json({ message: `Plugin not found: ${pluginId}` }, 404)

      let manifest: PluginManifestType | null = null
      try {
        manifest = await Plugin.manifest(pluginId)
      } catch {
        // ignore
      }

      return c.json({
        pluginId,
        loaded: true,
        name: plugin.name,
        version: manifest?.version,
        hasManifest: manifest !== null,
        trustTier: determineTrustTier(plugin.pluginDir),
        manifest: manifest ?? null,
      })
    },
  )
