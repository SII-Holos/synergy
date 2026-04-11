import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js"
import { Skill } from "../skill/skill"
import { Instance } from "../scope/instance"
import { Global } from "../global"
import { errors } from "./error"
import { RuntimeReload } from "../runtime/reload"

function resolveScope(skill: Skill.Info): Skill.Scope {
  if (skill.scope) return skill.scope
  if (skill.builtin) return "builtin"
  const projectDir = Instance.directory
  if (skill.location.startsWith(projectDir + "/")) return "project"
  return "global"
}

function resolveBaseDir(scope: "project" | "global") {
  return scope === "project"
    ? path.join(Instance.directory, ".synergy", "skill")
    : path.join(Global.Path.config, "skill")
}

async function extractSkillZip(buffer: ArrayBuffer, baseDir: string): Promise<{ name: string }> {
  const zipReader = new ZipReader(new BlobReader(new Blob([buffer])))
  const entries = await zipReader.getEntries()

  if (entries.length === 0) {
    await zipReader.close()
    throw new Error("Empty archive")
  }

  const skillMdEntry = entries.find((e) => e.filename.endsWith("/SKILL.md") || e.filename === "SKILL.md")
  if (!skillMdEntry) {
    await zipReader.close()
    throw new Error("No SKILL.md found in archive")
  }

  for (const entry of entries) {
    if (entry.directory || !entry.getData) continue
    const blobWriter = new BlobWriter()
    const blob = await entry.getData(blobWriter)
    const data = new Uint8Array(await blob.arrayBuffer())
    const outPath = path.join(baseDir, entry.filename)
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await Bun.write(outPath, data)
  }

  await zipReader.close()

  const skillMdPath = path.join(baseDir, skillMdEntry.filename)
  let skillName = "unknown"
  try {
    const content = await Bun.file(skillMdPath).text()
    const matter = await import("gray-matter")
    const parsed = matter.default(content)
    skillName = parsed.data?.name || path.basename(path.dirname(skillMdPath))
  } catch {
    skillName = path.basename(path.dirname(skillMdPath))
  }

  await RuntimeReload.reload({
    targets: ["skill"],
    reason: "skill archive import",
  })
  return { name: skillName }
}

export const SkillRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List skills",
      description: "Get a list of all available skills in the Synergy system.",
      operationId: "skill.list",
      responses: {
        200: {
          description: "List of skills",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    items: z.array(
                      z.object({
                        name: z.string(),
                        description: z.string(),
                        location: z.string(),
                        builtin: z.boolean().optional(),
                        source: Skill.Source.optional(),
                        scope: Skill.Scope,
                        compatibility: Skill.Compatibility.optional(),
                        entryFile: z.string().optional(),
                        baseDir: z.string().optional(),
                        references: z.array(z.string()).optional(),
                        scripts: z.array(z.string()).optional(),
                      }),
                    ),
                    diagnostics: Skill.Diagnostic.array(),
                  })
                  .meta({ ref: "SkillList" }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const [skills, diagnostics] = await Promise.all([Skill.all(), Skill.diagnostics()])
      return c.json({
        items: skills.map((s) => ({
          name: s.name,
          description: s.description,
          location: s.location,
          builtin: s.builtin,
          source: s.source,
          scope: resolveScope(s),
          compatibility: s.compatibility,
          entryFile: s.entryFile,
          baseDir: s.baseDir,
          references: s.references ? Object.keys(s.references) : undefined,
          scripts: s.scripts ? Object.keys(s.scripts) : undefined,
        })),
        diagnostics,
      })
    },
  )
  .post(
    "/reload",
    describeRoute({
      summary: "Reload skills",
      description: "Reload all skills by rescanning skill directories.",
      operationId: "skill.reload",
      responses: {
        200: {
          description: "Skills reloaded successfully",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
      },
    }),
    async (c) => {
      await RuntimeReload.reload({
        targets: ["skill"],
        reason: "skill.reload route",
      })
      return c.json(true)
    },
  )
  .delete(
    "/:name",
    describeRoute({
      summary: "Delete a skill",
      description: "Delete a non-builtin skill by removing its directory from disk.",
      operationId: "skill.remove",
      responses: {
        200: {
          description: "Skill deleted successfully",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.literal(true) })),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const name = c.req.param("name")
      const skill = await Skill.get(name)
      if (!skill) {
        return c.json({ error: "Skill not found", name }, 404)
      }
      if (skill.builtin) {
        return c.json({ error: "Cannot delete builtin skills", name }, 400)
      }
      const skillDir = path.dirname(skill.location)
      await fs.rm(skillDir, { recursive: true, force: true })
      await RuntimeReload.reload({
        targets: ["skill"],
        reason: `skill.remove:${name}`,
      })
      return c.json({ success: true as const })
    },
  )
  .post(
    "/import",
    describeRoute({
      summary: "Import a skill",
      description: "Import a skill from a .skill or .zip file. Extracts to the project or global skill directory.",
      operationId: "skill.import",
      responses: {
        200: {
          description: "Skill imported successfully",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  success: z.literal(true),
                  name: z.string(),
                  scope: z.enum(["global", "project"]),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("form", z.object({ file: z.any(), scope: z.enum(["project", "global"]).optional() })),
    async (c) => {
      const { file, scope: targetScope } = c.req.valid("form")
      if (!(file instanceof File)) {
        return c.json({ error: "Missing file field" }, 400)
      }

      const scope = targetScope || "global"
      const baseDir = resolveBaseDir(scope)

      try {
        const buffer = await file.arrayBuffer()
        const result = await extractSkillZip(buffer, baseDir)
        return c.json({ success: true as const, name: result.name, scope })
      } catch (e: any) {
        return c.json({ error: e.message || "Failed to extract archive" }, 400)
      }
    },
  )
  .post(
    "/import-url",
    describeRoute({
      summary: "Import a skill from URL",
      description: "Download a .zip file from a URL and import it as a skill.",
      operationId: "skill.importUrl",
      responses: {
        200: {
          description: "Skill imported successfully",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  success: z.literal(true),
                  name: z.string(),
                  scope: z.enum(["global", "project"]),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        url: z.string().url(),
        scope: z.enum(["project", "global"]).optional(),
      }),
    ),
    async (c) => {
      const { url, scope: targetScope } = c.req.valid("json")
      const scope = targetScope || "global"
      const baseDir = resolveBaseDir(scope)

      try {
        const response = await fetch(url, { redirect: "follow" })
        if (!response.ok) {
          return c.json({ error: `Failed to download: ${response.status} ${response.statusText}` }, 400)
        }
        const buffer = await response.arrayBuffer()
        const result = await extractSkillZip(buffer, baseDir)
        return c.json({ success: true as const, name: result.name, scope })
      } catch (e: any) {
        return c.json({ error: e.message || "Failed to download or extract" }, 400)
      }
    },
  )
