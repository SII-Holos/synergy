import fs from "fs/promises"
import path from "path"
import { Hono, type Context, type Next } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { RuntimeReload } from "../runtime/reload"
import { ScopeContext } from "../scope/context"
import { SkillArchive } from "../skill/archive"
import { Skill } from "../skill/skill"
import { SkillSourceProfile } from "../skill/source-profile"
import { SkillSummary } from "../skill/summary"
import { errors } from "./error"
import { requestWithinLimit } from "./request-body-limit"

const Scope = z.enum(["project", "global"])
const ImportResult = z
  .object({
    success: z.literal(true),
    name: z.string(),
    scope: Scope,
  })
  .meta({ ref: "SkillImportResult" })
const RemoveResult = z.object({ success: z.literal(true) }).meta({ ref: "SkillRemoveResult" })
const RemoveFailure = z
  .object({
    error: z.string(),
    name: z.string(),
    pluginId: z.string().optional(),
  })
  .meta({ ref: "SkillRemoveFailure" })

function resolveDestination(scope: z.infer<typeof Scope>) {
  const destination = SkillSourceProfile.writableDestination(scope, ScopeContext.current.directory)
  if (!destination) throw new Error(`No writable Skill destination for ${scope} scope`)
  return destination
}

function archiveErrorResponse(error: unknown) {
  if (error instanceof SkillArchive.ConflictError) return { status: 409 as const, body: error.toObject() }
  if (error instanceof SkillArchive.LimitError) return { status: 413 as const, body: error.toObject() }
  if (
    error instanceof SkillArchive.InvalidError ||
    error instanceof SkillArchive.ExportNotStandardError ||
    error instanceof SkillArchive.ExportUnavailableError ||
    error instanceof SkillArchive.NotFoundError
  ) {
    return { status: 400 as const, body: error.toObject() }
  }
  throw error
}

function limitImportBody(maxBytes: number) {
  return async (c: Context, next: Next) => {
    const declared = Number(c.req.header("content-length") ?? 0)
    if ((Number.isFinite(declared) && declared > maxBytes) || !(await requestWithinLimit(c.req.raw, maxBytes))) {
      const error = new SkillArchive.LimitError({
        code: "skill.archive_request_size_limit",
        message: `Skill import request exceeds ${maxBytes} bytes`,
        limit: maxBytes,
        actual: Number.isFinite(declared) ? declared : undefined,
      })
      return c.json(error.toObject(), 413)
    }
    await next()
  }
}

function validateArchiveName(filename: string) {
  const extension = path.extname(filename).toLowerCase()
  if (extension === ".zip" || extension === ".skill") return
  throw new SkillArchive.InvalidError({
    code: "skill.archive_extension_invalid",
    message: "Skill archives must use the .zip or .skill extension",
    path: filename,
  })
}

const MAX_URL_REDIRECTS = 5

function validateDownloadUrl(url: URL) {
  if (url.protocol === "http:" || url.protocol === "https:") return
  throw new SkillArchive.InvalidError({
    code: "skill.archive_url_invalid",
    message: "Skill archive URLs must use HTTP or HTTPS",
    path: url.toString(),
  })
}

async function fetchArchive(url: URL) {
  const signal = AbortSignal.timeout(15_000)
  let current = url
  for (let redirects = 0; redirects <= MAX_URL_REDIRECTS; redirects++) {
    validateDownloadUrl(current)
    const response = await fetch(current, {
      redirect: "manual",
      signal,
      headers: { Accept: "application/zip, application/octet-stream" },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get("location")
    await response.body?.cancel().catch(() => {})
    if (!location) {
      throw new SkillArchive.InvalidError({
        code: "skill.archive_url_fetch_failed",
        message: `Skill archive redirect is missing a Location header: HTTP ${response.status}`,
        path: current.toString(),
      })
    }
    if (redirects === MAX_URL_REDIRECTS) {
      throw new SkillArchive.InvalidError({
        code: "skill.archive_url_redirect_limit",
        message: `Skill archive URL exceeded ${MAX_URL_REDIRECTS} redirects`,
        path: url.toString(),
      })
    }
    current = new URL(location, current)
  }
  throw new Error("Unreachable redirect state")
}

async function readBoundedResponse(response: Response, source: string) {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > SkillArchive.Policy.maxArchiveBytes) {
    throw new SkillArchive.LimitError({
      code: "skill.archive_size_limit",
      message: "Downloaded Skill archive exceeds the compressed size limit",
      limit: SkillArchive.Policy.maxArchiveBytes,
      actual: declared,
      path: source,
    })
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > SkillArchive.Policy.maxArchiveBytes) {
        await reader.cancel().catch(() => {})
        throw new SkillArchive.LimitError({
          code: "skill.archive_size_limit",
          message: "Downloaded Skill archive exceeds the compressed size limit",
          limit: SkillArchive.Policy.maxArchiveBytes,
          actual: total,
          path: source,
        })
      }
      chunks.push(item.value.slice())
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function install(bytes: ArrayBuffer | Uint8Array, scope: z.infer<typeof Scope>) {
  const result = await SkillArchive.install({ bytes, destination: resolveDestination(scope) })
  await RuntimeReload.reload({ targets: ["skill"], reason: `skill.import:${result.name}` })
  return { success: true as const, name: result.name, scope }
}

export const SkillRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List skills",
      description: "Get canonical public summaries and diagnostics for all available Skills.",
      operationId: "skill.list",
      responses: {
        200: {
          description: "List of Skills",
          content: { "application/json": { schema: resolver(SkillSummary.List) } },
        },
      },
    }),
    async (c) => {
      const [skills, diagnostics] = await Promise.all([Skill.all(), Skill.diagnostics()])
      return c.json({
        items: skills.map(SkillSummary.from),
        diagnostics,
      })
    },
  )
  .post(
    "/reload",
    describeRoute({
      summary: "Reload skills",
      description: "Reload all Skills by rescanning configured Skill directories.",
      operationId: "skill.reload",
      responses: {
        200: {
          description: "Skills reloaded successfully",
          content: { "application/json": { schema: resolver(RuntimeReload.Result) } },
        },
      },
    }),
    async (c) =>
      c.json(
        await RuntimeReload.reload({
          targets: ["skill"],
          reason: "skill.reload route",
        }),
      ),
  )
  .get(
    "/:name/export",
    describeRoute({
      summary: "Export a Skill",
      description: "Download a strict-standard, file-backed Skill as a ZIP archive.",
      operationId: "skill.export",
      responses: {
        200: {
          description: "Skill archive",
          content: { "application/zip": { schema: resolver(z.file()) } },
        },
        400: {
          description: "Skill is not exportable or not strict-standard",
          content: { "application/json": { schema: resolver(SkillArchive.ExportError) } },
        },
      },
    }),
    validator("param", z.object({ name: z.string().min(1) })),
    validator("query", z.object({ format: z.enum(["zip", "skill"]).default("zip") })),
    async (c) => {
      const { name } = c.req.valid("param")
      const { format } = c.req.valid("query")
      try {
        const skill = await Skill.get(name)
        if (!skill) {
          throw new SkillArchive.NotFoundError({
            code: "skill.export_not_found",
            message: `Skill '${name}' was not found`,
            name,
          })
        }
        const result = await SkillArchive.createExport({ skill, instanceDirectory: ScopeContext.current.directory })
        return c.body(new Uint8Array(result.bytes).buffer, 200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${skill.name}.${format}"`,
          "Content-Encoding": "identity",
        })
      } catch (error) {
        const response = archiveErrorResponse(error)
        return c.json(response.body, response.status)
      }
    },
  )
  .delete(
    "/:name",
    describeRoute({
      summary: "Delete a Skill",
      description: "Delete a non-builtin, non-plugin Skill from disk.",
      operationId: "skill.remove",
      responses: {
        200: {
          description: "Skill deleted successfully",
          content: { "application/json": { schema: resolver(RemoveResult) } },
        },
        400: {
          description: "Skill cannot be deleted",
          content: { "application/json": { schema: resolver(RemoveFailure) } },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const name = c.req.param("name")
      const skill = await Skill.get(name)
      if (!skill) return c.json({ error: "Skill not found", name }, 404)
      if (skill.origin.kind === "builtin") return c.json({ error: "Cannot delete builtin skills", name }, 400)
      if (skill.origin.kind === "plugin") {
        return c.json({ error: "Cannot delete plugin skills", name, pluginId: skill.origin.pluginID }, 400)
      }
      if (skill.backing.kind !== "file")
        return c.json({ error: "Cannot delete a Skill without file backing", name }, 400)
      if (!(await SkillSourceProfile.containsCanonicalPath(skill.backing.baseDir, ScopeContext.current.directory))) {
        return c.json({ error: "Cannot delete a Skill outside trusted Skill roots", name }, 400)
      }
      await fs.rm(skill.backing.baseDir, { recursive: true, force: true })
      await RuntimeReload.reload({ targets: ["skill"], reason: `skill.remove:${name}` })
      return c.json({ success: true as const })
    },
  )
  .post(
    "/import",
    describeRoute({
      summary: "Import a Skill",
      description: "Transactionally import a .zip or .skill ZIP archive into project or global scope.",
      operationId: "skill.import",
      responses: {
        200: {
          description: "Skill imported successfully",
          content: { "application/json": { schema: resolver(ImportResult) } },
        },
        400: {
          description: "Invalid Skill archive",
          content: { "application/json": { schema: resolver(SkillArchive.InvalidError.Schema) } },
        },
        409: {
          description: "A Skill with the same name already exists",
          content: { "application/json": { schema: resolver(SkillArchive.ConflictError.Schema) } },
        },
        413: {
          description: "Skill archive exceeds an import limit",
          content: { "application/json": { schema: resolver(SkillArchive.LimitError.Schema) } },
        },
      },
    }),
    limitImportBody(SkillArchive.Policy.maxRequestBytes),
    validator("form", z.object({ file: z.any(), scope: Scope.optional() })),
    async (c) => {
      const { file, scope: requestedScope } = c.req.valid("form")
      try {
        if (!(file instanceof File)) {
          throw new SkillArchive.InvalidError({
            code: "skill.archive_file_missing",
            message: "Missing Skill archive file field",
          })
        }
        validateArchiveName(file.name)
        if (file.size > SkillArchive.Policy.maxArchiveBytes) {
          throw new SkillArchive.LimitError({
            code: "skill.archive_size_limit",
            message: "Skill archive exceeds the compressed size limit",
            limit: SkillArchive.Policy.maxArchiveBytes,
            actual: file.size,
            path: file.name,
          })
        }
        return c.json(await install(await file.arrayBuffer(), requestedScope ?? "global"))
      } catch (error) {
        const response = archiveErrorResponse(error)
        return c.json(response.body, response.status)
      }
    },
  )
  .post(
    "/import-url",
    describeRoute({
      summary: "Import a Skill from URL",
      description: "Download a bounded .zip or .skill archive and pass its bytes to the transactional Skill importer.",
      operationId: "skill.importUrl",
      responses: {
        200: {
          description: "Skill imported successfully",
          content: { "application/json": { schema: resolver(ImportResult) } },
        },
        400: {
          description: "Invalid URL response or Skill archive",
          content: { "application/json": { schema: resolver(SkillArchive.InvalidError.Schema) } },
        },
        409: {
          description: "A Skill with the same name already exists",
          content: { "application/json": { schema: resolver(SkillArchive.ConflictError.Schema) } },
        },
        413: {
          description: "Downloaded Skill archive exceeds an import limit",
          content: { "application/json": { schema: resolver(SkillArchive.LimitError.Schema) } },
        },
      },
    }),
    validator(
      "json",
      z.object({
        url: z.string().url(),
        scope: Scope.optional(),
      }),
    ),
    async (c) => {
      const { url, scope: requestedScope } = c.req.valid("json")
      try {
        const parsed = new URL(url)
        validateDownloadUrl(parsed)
        validateArchiveName(parsed.pathname)
        let response: Response
        try {
          response = await fetchArchive(parsed)
        } catch (error) {
          if (error instanceof SkillArchive.InvalidError) throw error
          throw new SkillArchive.InvalidError({
            code: "skill.archive_url_fetch_failed",
            message: error instanceof Error ? error.message : "Unable to download Skill archive",
            path: url,
          })
        }
        if (!response.ok) {
          throw new SkillArchive.InvalidError({
            code: "skill.archive_url_fetch_failed",
            message: `Unable to download Skill archive: HTTP ${response.status}`,
            path: url,
          })
        }
        return c.json(await install(await readBoundedResponse(response, url), requestedScope ?? "global"))
      } catch (error) {
        const result = archiveErrorResponse(error)
        return c.json(result.body, result.status)
      }
    },
  )
