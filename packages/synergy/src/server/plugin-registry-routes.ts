import { Hono, type Context, type Next } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import path from "path"
import fs from "fs"
import { errors } from "./error"
import { Global } from "../global"
import { checkPathContainment } from "../util/path-contain"
import { PluginMarketplaceRegistry } from "../plugin/marketplace-registry"

// ── Types ──

const PermissionItem = z
  .object({
    key: z.string(),
    description: z.string(),
    risk: z.enum(["low", "medium", "high"]),
    granted: z.boolean().optional(),
  })
  .meta({ ref: "RegistryPermissionItem" })

const RegistryPermissionSummary = z
  .object({
    key: z.string(),
    category: z.string(),
    severity: z.string(),
    title: z.string(),
    description: z.string(),
  })
  .meta({ ref: "RegistryPermissionSummary" })

const PluginSignature = z
  .object({
    algorithm: z.literal("ed25519"),
    signer: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .meta({ ref: "RegistryPluginSignature" })

const RegistryPluginVersion = z
  .object({
    version: z.string(),
    manifestHash: z.string(),
    permissionsHash: z.string(),
    signature: PluginSignature.optional(),
    signatureUrl: z.string().optional(),
    downloadUrl: z.string().optional(),
    integrity: z.string(),
    risk: z.enum(["low", "medium", "high"]),
    runtimeMode: z.enum(["in-process", "worker", "process"]).optional(),
    permissionsSummary: z.array(PermissionItem),
    tools: z.array(z.string()).optional(),
    uiSurfaces: z.array(z.string()).optional(),
    publishedAt: z.number(),
    changelog: z.string().optional(),
    source: PluginMarketplaceRegistry.Source.optional(),
  })
  .meta({ ref: "RegistryPluginVersion" })

const RegistryPluginEntry = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    repo: z.string().optional(),
    homepage: z.string().optional(),
    author: z.object({
      name: z.string(),
      email: z.string().optional(),
      url: z.string().optional(),
    }),
    verified: z.boolean(),
    official: z.boolean(),
    keywords: z.array(z.string()),
    compatibility: z.object({ synergy: z.string() }),
    versions: z.array(RegistryPluginVersion),
    createdAt: z.number(),
    updatedAt: z.number(),
    // v2 fields
    risk: z.enum(["low", "medium", "high"]),
    trustTier: z.enum(["declarative", "trusted-import", "sandbox"]),
    runtimeMode: z.enum(["in-process", "worker", "process"]),
    permissionsSummary: z.array(RegistryPermissionSummary),
    uiSurfaces: z.array(z.string()),
    tools: z.array(z.string()),
    downloads: z.number(),
    rating: z.number().optional(),
    ratingCount: z.number().optional(),
    changelog: z.string().optional(),
    source: PluginMarketplaceRegistry.Source.optional(),
    entryUrl: z.string().optional(),
    yankedVersions: z.array(z.string()).optional(),
  })
  .meta({ ref: "RegistryPluginEntry" })

type RegistryPluginEntry = z.infer<typeof RegistryPluginEntry>
type RegistryPluginVersion = z.infer<typeof RegistryPluginVersion>

const RegistryPluginSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    repo: z.string().optional(),
    author: z.object({
      name: z.string(),
      email: z.string().optional(),
      url: z.string().optional(),
    }),
    verified: z.boolean(),
    official: z.boolean(),
    keywords: z.array(z.string()),
    latestVersion: z.string().optional(),
    updatedAt: z.number(),
    // v2 fields
    risk: z.enum(["low", "medium", "high"]),
    trustTier: z.enum(["declarative", "trusted-import", "sandbox"]),
    runtimeMode: z.enum(["in-process", "worker", "process"]),
    uiSurfaces: z.array(z.string()),
    tools: z.array(z.string()),
    downloads: z.number(),
    rating: z.number().optional(),
    source: PluginMarketplaceRegistry.Source,
  })
  .meta({ ref: "RegistryPluginSummary" })

type RegistryPluginSummary = z.infer<typeof RegistryPluginSummary>

// Publish input: full entry without server-managed timestamps
const PublishInput = RegistryPluginEntry.omit({ createdAt: true, updatedAt: true }).meta({
  ref: "RegistryPublishInput",
})

// ── Helpers ──

function registryPath(): string {
  return path.join(Global.Path.data, "registry", "plugins.json")
}

function missingFileError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (err as NodeJS.ErrnoException).code === "ENOENT"
}

async function loadRegistry(): Promise<RegistryPluginEntry[]> {
  const file = Bun.file(registryPath())
  try {
    const exists = await file.exists()
    if (!exists) return []
  } catch (err) {
    if (missingFileError(err)) return []
    throw err
  }
  const text = await file.text()
  const parsed = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.plugins)) return parsed.plugins
  return []
}

function localSummary(p: RegistryPluginEntry): RegistryPluginSummary {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    repo: p.repo,
    author: p.author,
    verified: p.verified,
    official: p.official,
    keywords: p.keywords,
    latestVersion: p.versions.length > 0 ? p.versions[p.versions.length - 1].version : undefined,
    updatedAt: p.updatedAt,
    risk: p.risk,
    trustTier: p.trustTier,
    runtimeMode: p.runtimeMode,
    uiSurfaces: p.uiSurfaces,
    tools: p.tools,
    downloads: p.downloads,
    rating: p.rating,
    source: "local",
  }
}

function localEntry(entry: RegistryPluginEntry): RegistryPluginEntry {
  return {
    ...entry,
    source: "local",
    versions: entry.versions.map((version) => ({ ...version, source: "local" })),
  }
}

async function searchLocal(query: string): Promise<RegistryPluginSummary[]> {
  const plugins = await loadRegistry()
  const q = query.toLowerCase().trim()
  const results = q
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.keywords.some((k) => k.toLowerCase().includes(q)),
      )
    : plugins
  return results.map(localSummary)
}

function mergeSummaries(
  official: PluginMarketplaceRegistry.NormalizedSummary[],
  local: RegistryPluginSummary[],
): RegistryPluginSummary[] {
  const seen = new Set<string>()
  const merged: RegistryPluginSummary[] = []
  for (const summary of [...official, ...local]) {
    const key = `${summary.source}:${summary.id}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(summary)
  }
  return merged.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function saveRegistry(plugins: RegistryPluginEntry[]): Promise<void> {
  const realPath = registryPath()
  const tmpPath = realPath + ".tmp"
  const dir = path.dirname(realPath)
  fs.mkdirSync(dir, { recursive: true })
  await Bun.write(tmpPath, JSON.stringify({ plugins }, null, 2))
  fs.renameSync(tmpPath, realPath)
}

function isLoopbackHost(input: string): boolean {
  const host = input.trim()
  if (!host) return false
  if (host.startsWith("[")) {
    const end = host.indexOf("]")
    return end >= 0 && host.slice(1, end) === "::1"
  }
  const hostname = host.split(":")[0]
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

function isLoopbackOrigin(input: string): boolean {
  try {
    const url = new URL(input)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    return isLoopbackHost(url.host)
  } catch {
    return false
  }
}

async function requireLocalRegistryPublish(c: Context, next: Next) {
  const host = c.req.header("host")
  if (host && !isLoopbackHost(host)) {
    return c.json({ message: "Plugin registry publishing is restricted to localhost" }, 403)
  }

  const origin = c.req.header("origin") || c.req.header("referer")
  if (origin && !isLoopbackOrigin(origin)) {
    return c.json({ message: "Plugin registry publishing is restricted to localhost" }, 403)
  }

  return next()
}

// ── Route group ──

export const RegistryRoute = new Hono()

  .use("/publish", requireLocalRegistryPublish)

  // GET /search — Search plugins by keyword
  .get(
    "/search",
    describeRoute({
      summary: "Search plugin registry",
      description: "Search plugins by keyword in name, description, and keywords with pagination.",
      operationId: "registry.plugins.search",
      responses: {
        200: {
          description: "Search results with pagination metadata",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  plugins: z.array(RegistryPluginSummary),
                  total: z.number(),
                  offset: z.number(),
                  limit: z.number(),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "query",
      z.object({
        q: z.string().optional().default(""),
        offset: z.coerce.number().int().min(0).optional().default(0),
        limit: z.coerce.number().int().min(1).max(100).optional().default(20),
        source: PluginMarketplaceRegistry.Source.optional(),
      }),
    ),
    async (c) => {
      const { q, offset, limit, source } = c.req.valid("query")
      const localEnabled = (await PluginMarketplaceRegistry.currentConfig()).includeLocalRegistry
      let official: PluginMarketplaceRegistry.NormalizedSummary[] = []
      let local: RegistryPluginSummary[] = []

      if (source !== "local") {
        try {
          official = (await PluginMarketplaceRegistry.searchOfficial({ q, offset: 0, limit: 1000 })).plugins
        } catch (err) {
          if (source === "official") {
            const message = err instanceof Error ? err.message : String(err)
            return c.json({ message }, 500)
          }
        }
      }

      if (source !== "official" && localEnabled) {
        local = await searchLocal(q)
      }

      const results = mergeSummaries(official, local)
      const total = results.length
      const summaries = results.slice(offset, offset + limit)
      return c.json({ plugins: summaries, total, offset, limit })
    },
  )

  // GET /:id — Get full plugin entry with latest version
  .get(
    "/:id",
    describeRoute({
      summary: "Get plugin entry",
      description: "Return the full registry entry for a plugin, including its latest version.",
      operationId: "registry.plugins.get",
      responses: {
        200: {
          description: "Plugin registry entry",
          content: {
            "application/json": { schema: resolver(RegistryPluginEntry) },
          },
        },
        ...errors(404),
      },
    }),
    validator(
      "query",
      z.object({
        source: PluginMarketplaceRegistry.Source.optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param("id")
      const { source } = c.req.valid("query")
      const config = await PluginMarketplaceRegistry.currentConfig()

      if (source !== "local") {
        const official = await PluginMarketplaceRegistry.getOfficialEntry(id).catch((err) => {
          if (source === "official") throw err
          return null
        })
        if (official) return c.json(official)
      }

      if (source !== "official" && config.includeLocalRegistry) {
        const plugins = await loadRegistry()
        const entry = plugins.find((p) => p.id === id)
        if (entry) return c.json(localEntry(entry))
      }

      return c.json({ message: `Registry plugin not found: ${id}` }, 404)
    },
  )

  // GET /:id/versions — List all versions for a plugin
  .get(
    "/:id/versions",
    describeRoute({
      summary: "List plugin versions",
      description: "Return all published versions for a plugin.",
      operationId: "registry.plugins.versions",
      responses: {
        200: {
          description: "Plugin version list",
          content: {
            "application/json": { schema: resolver(z.array(RegistryPluginVersion)) },
          },
        },
        ...errors(404),
      },
    }),
    validator(
      "query",
      z.object({
        source: PluginMarketplaceRegistry.Source.optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param("id")
      const { source } = c.req.valid("query")
      const config = await PluginMarketplaceRegistry.currentConfig()

      if (source !== "local") {
        const official = await PluginMarketplaceRegistry.getOfficialEntry(id).catch((err) => {
          if (source === "official") throw err
          return null
        })
        if (official) return c.json(official.versions)
      }

      if (source !== "official" && config.includeLocalRegistry) {
        const plugins = await loadRegistry()
        const entry = plugins.find((p) => p.id === id)
        if (entry) return c.json(localEntry(entry).versions)
      }

      return c.json({ message: `Registry plugin not found: ${id}` }, 404)
    },
  )

  // GET /:id/versions/:version — Get a specific version
  .get(
    "/:id/versions/:version",
    describeRoute({
      summary: "Get plugin version",
      description: "Return details for a specific version of a plugin.",
      operationId: "registry.plugins.version",
      responses: {
        200: {
          description: "Plugin version details",
          content: {
            "application/json": { schema: resolver(RegistryPluginVersion) },
          },
        },
        ...errors(404),
      },
    }),
    validator(
      "query",
      z.object({
        source: PluginMarketplaceRegistry.Source.optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param("id")
      const version = c.req.param("version")
      const { source } = c.req.valid("query")
      const config = await PluginMarketplaceRegistry.currentConfig()

      if (source !== "local") {
        const official = await PluginMarketplaceRegistry.getOfficialEntry(id).catch((err) => {
          if (source === "official") throw err
          return null
        })
        const ver = official?.versions.find((v) => v.version === version)
        if (ver) return c.json(ver)
      }

      if (source !== "official" && config.includeLocalRegistry) {
        const plugins = await loadRegistry()
        const entry = plugins.find((p) => p.id === id)
        if (entry) {
          const ver = localEntry(entry).versions.find((v) => v.version === version)
          if (ver) return c.json(ver)
        }
      }

      return c.json({ message: `Version not found: ${id}@${version}` }, 404)
    },
  )

  // GET /:id/download/:version — Download a plugin version archive
  .get(
    "/:id/download/:version",
    describeRoute({
      summary: "Download plugin version",
      description:
        "Download a plugin version archive. If downloadUrl is a file:// path within the registry store, streams the file. Otherwise returns 501.",
      operationId: "registry.plugins.download",
      responses: {
        200: { description: "Plugin archive binary" },
        ...errors(404),
        501: { description: "Download not yet implemented for this entry" },
      },
    }),
    async (c) => {
      const id = c.req.param("id")
      const version = c.req.param("version")
      const plugins = await loadRegistry()
      const entry = plugins.find((p) => p.id === id)
      if (!entry) return c.json({ message: `Registry plugin not found: ${id}` }, 404)
      const ver = entry.versions.find((v) => v.version === version)
      if (!ver) return c.json({ message: `Version not found: ${id}@${version}` }, 404)

      const downloadUrl = ver.downloadUrl
      if (!downloadUrl) {
        return c.json({ message: "No download URL for this version" }, 501)
      }

      // If it's a file:// URL within the registry store, stream it
      if (downloadUrl.startsWith("file://")) {
        let filePath: string
        try {
          filePath = new URL(downloadUrl).pathname
        } catch {
          return c.json({ message: "Invalid download URL" }, 400)
        }

        const registryStore = path.join(Global.Path.data, "registry")
        const resolved = checkPathContainment(registryStore, filePath)
        if (!resolved) {
          return c.json({ message: "Path traversal denied" }, 403)
        }

        const file = Bun.file(resolved)
        let exists: boolean
        try {
          exists = await file.exists()
        } catch (err) {
          if (missingFileError(err)) {
            return c.json({ message: "Download file not found" }, 404)
          }
          throw err
        }
        if (!exists) {
          return c.json({ message: "Download file not found" }, 404)
        }

        // Increment download counter
        entry.downloads += 1
        await saveRegistry(plugins)

        c.header("Content-Disposition", `attachment; filename="${id}-${version}.tar.gz"`)
        c.header("Content-Type", "application/gzip")
        return c.body(file.stream())
      }

      // Other URLs not yet implemented
      return c.json({ message: "Download not yet implemented" }, 501)
    },
  )

  // POST /publish — Publish a plugin entry
  .post(
    "/publish",
    describeRoute({
      summary: "Publish plugin entry",
      description: "Publish a new plugin entry or update an existing one. Local registry publishing is localhost-only.",
      operationId: "registry.plugins.publish",
      responses: {
        200: {
          description: "Published plugin entry",
          content: {
            "application/json": { schema: resolver(RegistryPluginEntry) },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", PublishInput),
    async (c) => {
      const input = c.req.valid("json")
      const now = Date.now()
      const plugins = await loadRegistry()
      const existing = plugins.findIndex((p) => p.id === input.id)

      if (existing >= 0) {
        // Update existing entry
        const prev = plugins[existing]
        const updated: RegistryPluginEntry = {
          ...input,
          createdAt: prev.createdAt,
          updatedAt: now,
          versions: input.versions.map((v) => ({ ...v })),
        }
        plugins[existing] = updated
        await saveRegistry(plugins)
        return c.json(updated)
      }

      // New entry
      const created: RegistryPluginEntry = {
        ...input,
        createdAt: now,
        updatedAt: now,
        versions: input.versions.map((v) => ({ ...v })),
      }
      plugins.push(created)
      await saveRegistry(plugins)
      return c.json(created)
    },
  )
