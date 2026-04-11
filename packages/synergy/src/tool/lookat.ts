import z from "zod"
import * as path from "path"
import { pathToFileURL } from "url"
import { Tool } from "./tool"
import { SessionInteraction } from "@/session/interaction"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { Instance } from "../scope/instance"
import { workMap } from "../util/queue"
import DESCRIPTION from "./lookat.txt"

const MULTIMODAL_AGENT = "multimodal-looker"
const CONCURRENCY_LIMIT = 5

const parameters = z.object({
  file_path: z.union([z.string(), z.array(z.string())]).describe("Absolute path(s) to the file(s) to analyze"),
  goal: z.string().describe("What specific information to extract from the file(s)"),
})

interface LookAtMetadata {
  filePath?: string
  mimeType?: string
  fileCount?: number
  error?: string
}

function inferMimeType(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".pdf": "application/pdf",
  }
  return mimeTypes[ext] || "application/octet-stream"
}

export const LookAtTool = Tool.define<typeof parameters, LookAtMetadata>("look_at", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      const paths = Array.isArray(params.file_path) ? params.file_path : [params.file_path]

      const files: Array<{ filepath: string; mimeType: string; filename: string }> = []
      for (const raw of paths) {
        const filepath = path.isAbsolute(raw) ? raw : path.join(Instance.directory, raw)
        if (!(await Bun.file(filepath).exists())) {
          return {
            title: "File not found",
            output: `Error: File not found: ${filepath}`,
            metadata: { error: "file_not_found" },
          }
        }
        files.push({ filepath, mimeType: inferMimeType(filepath), filename: path.basename(filepath) })
      }

      // Deduplicated external directory permissions
      const externalDirs = new Set<string>()
      for (const file of files) {
        if (!Instance.contains(file.filepath)) {
          externalDirs.add(path.dirname(file.filepath))
        }
      }
      for (const dir of externalDirs) {
        await ctx.ask({
          permission: "external_directory",
          patterns: [dir],
          metadata: { dir },
        })
      }

      const agent = await Agent.get(MULTIMODAL_AGENT)
      if (!agent) {
        return {
          title: "Agent not found",
          output: `Error: ${MULTIMODAL_AGENT} agent is not configured`,
          metadata: { error: "agent_not_found" },
        }
      }

      const model = await Agent.getAvailableModel(agent)
      if (!model) {
        return {
          title: "Model not available",
          output: `Error: No available model found for ${MULTIMODAL_AGENT} agent`,
          metadata: { error: "model_not_available" },
        }
      }

      ctx.metadata({
        title: files.length === 1 ? `Analyzing: ${files[0].filename}` : `Analyzing ${files.length} files...`,
        metadata: files.length === 1 ? { filePath: files[0].filepath } : { fileCount: files.length },
      })

      const processFile = async (file: (typeof files)[number]) => {
        const { Session } = await import("../session")
        const { SessionInvoke } = await import("../session/invoke")
        const session = await Session.create({
          parentID: ctx.sessionID,
          title: `look_at: ${file.filename}`,
          interaction: SessionInteraction.unattended("tool:look_at"),
          permission: [
            { permission: "task", pattern: "*", action: "deny" },
            { permission: "look_at", pattern: "*", action: "deny" },
            { permission: "write", pattern: "*", action: "deny" },
            { permission: "edit", pattern: "*", action: "deny" },
            { permission: "bash", pattern: "*", action: "deny" },
          ],
        })

        const prompt = `Analyze this file and extract the requested information.

Goal: ${params.goal}

Provide ONLY the extracted information that matches the goal.
Be thorough on what was requested, concise on everything else.
If the requested information is not found, clearly state what is missing.`

        const result = await SessionInvoke.invoke({
          messageID: Identifier.ascending("message"),
          sessionID: session.id,
          model,
          agent: MULTIMODAL_AGENT,
          parts: [
            { type: "text", text: prompt },
            {
              type: "file",
              mime: file.mimeType,
              url: pathToFileURL(file.filepath).href,
              filename: file.filename,
            },
          ],
        })

        const textPart = result.parts.findLast((p: { type: string }) => p.type === "text")
        return (textPart as { text: string } | undefined)?.text ?? "No response from multimodal agent"
      }

      const results = await workMap(CONCURRENCY_LIMIT, files, (file) =>
        processFile(file).catch(
          (error) => `Error analyzing ${file.filename}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )

      if (files.length === 1) {
        return {
          title: `Analyzed: ${files[0].filename}`,
          output: results[0],
          metadata: { filePath: files[0].filepath, mimeType: files[0].mimeType },
        }
      }

      const output = files.map((file, i) => `## ${file.filename}\n${results[i]}`).join("\n\n")
      return {
        title: `Analyzed ${files.length} files`,
        output,
        metadata: { fileCount: files.length },
      }
    },
  }
})
