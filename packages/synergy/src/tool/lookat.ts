import z from "zod"
import * as path from "path"
import { pathToFileURL } from "url"
import { Tool } from "./tool"
import { SessionInteraction } from "@/session/interaction"
import type { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./lookat.txt"
import { Asset } from "../asset/asset"
import { ToolTimeout } from "./timeout"

const MULTIMODAL_AGENT = "multimodal-looker"
const MAX_IMAGES = 5
const DEFAULT_TIMEOUT_S = ToolTimeout.DEFAULTS.lookAtMs / 1_000

const parameters = z.object({
  file_path: z
    .union([z.string(), z.array(z.string())])
    .describe(`Absolute path or array of up to ${MAX_IMAGES} paths to the image(s) to analyze`),
  goal: z.string().describe("What specific information to extract from the file(s)"),
  timeout: z
    .number()
    .describe(
      `Optional timeout in seconds. If not specified, analysis will time out after ${DEFAULT_TIMEOUT_S} seconds (${DEFAULT_TIMEOUT_S / 60} minutes).`,
    )
    .optional(),
  show_to_user: z
    .boolean()
    .describe(
      "When true, also deliver the analyzed image(s) to the user as visible attachments. Use this when the user should see the same visual result you are analyzing.",
    )
    .optional(),
})

interface LookAtMetadata {
  filePath?: string
  mimeType?: string
  fileCount?: number
  error?: string
  timeout?: number
  timedOut?: boolean
  shownToUser?: boolean
}

async function toVisibleAttachment(
  file: { filepath: string; mimeType: string; filename: string },
  ctx: { sessionID: string; messageID: string },
): Promise<MessageV2.AttachmentPart> {
  const source = Bun.file(file.filepath)
  const buffer = Buffer.from(await source.arrayBuffer())
  const assetId = await Asset.write(buffer, file.mimeType)
  return {
    id: Identifier.ascending("part"),
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    type: "attachment",
    mime: file.mimeType,
    filename: file.filename,
    url: `asset://${assetId}`,
    localPath: file.filepath,
    presentation: { mode: "card" },
    model: {
      mode: "summary",
      summary: `${file.filename} (${file.mimeType}) analyzed by look_at`,
    },
  }
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
        const filepath = path.isAbsolute(raw) ? raw : path.join(ScopeContext.current.directory, raw)
        if (!(await Bun.file(filepath).exists())) {
          return {
            title: "File not found",
            output: `Error: File not found: ${filepath}`,
            metadata: { error: "file_not_found" },
          }
        }
        files.push({ filepath, mimeType: inferMimeType(filepath), filename: path.basename(filepath) })
      }

      const nonImages = files.filter((f) => !f.mimeType.startsWith("image/"))
      if (nonImages.length > 0) {
        return {
          title: "Unsupported file type",
          output: nonImages
            .map(
              (f) =>
                `${f.filename}: ${f.mimeType} — use the Read tool instead. look_at only supports image files (png, jpg, webp, gif, svg, heic).`,
            )
            .join("\n"),
          metadata: { error: "unsupported_file_type" },
        }
      }

      if (files.length > MAX_IMAGES) {
        return {
          title: "Too many images",
          output: `At most ${MAX_IMAGES} images can be analyzed in one call. You provided ${files.length} images. Split them across multiple look_at calls.`,
          metadata: { error: "too_many_files", fileCount: files.length },
        }
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
          title: "Image analysis disabled",
          output: `Error: Image analysis is disabled because no vision model is configured. Set vision_model in 10-models.jsonc to enable the look_at tool.`,
          metadata: { error: "model_not_available" },
        }
      }

      const timeout = params.timeout ?? DEFAULT_TIMEOUT_S

      ctx.metadata({
        title: files.length === 1 ? `Analyzing: ${files[0].filename}` : `Analyzing ${files.length} files...`,
        metadata: files.length === 1 ? { filePath: files[0].filepath, timeout } : { fileCount: files.length, timeout },
      })

      // Single session analyzing all images in one invoke call.
      const { Session } = await import("../session")
      const { SessionInvoke } = await import("../session/invoke")

      const sessionTitle = files.length === 1 ? `look_at: ${files[0].filename}` : `look_at: ${files.length} images`
      const session = await Session.create({
        parentID: ctx.sessionID,
        title: sessionTitle,
        interaction: SessionInteraction.unattended("tool:look_at"),
        permission: [
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "look_at", pattern: "*", action: "deny" },
          { permission: "write", pattern: "*", action: "deny" },
          { permission: "edit", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "*", action: "deny" },
        ],
      })

      const prompt =
        files.length === 1
          ? `Analyze this image and extract the requested information.

Goal: ${params.goal}

Provide ONLY the extracted information that matches the goal.
Be thorough on what was requested, concise on everything else.
If the requested information is not found, clearly state what is missing.`
          : `Analyze these ${files.length} images and extract the requested information for each one.

Goal: ${params.goal}

For each image, provide a separate analysis under a "## {filename}" header.
Be thorough on what was requested, concise on everything else.
If the requested information is not found, clearly state what is missing.`

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        SessionInvoke.cancel(session.id)
      }, timeout * 1000)

      let output: string
      try {
        const result = await SessionInvoke.invoke({
          messageID: Identifier.ascending("message"),
          sessionID: session.id,
          model,
          agent: MULTIMODAL_AGENT,
          parts: [
            { type: "text", text: prompt },
            ...files.map((file) => ({
              type: "attachment" as const,
              mime: file.mimeType,
              url: pathToFileURL(file.filepath).href,
              filename: file.filename,
              localPath: file.filepath,
              presentation: { mode: "card" as const },
              model: {
                mode: "provider-file" as const,
                summary: `${file.filename} (${file.mimeType})`,
              },
            })),
          ],
        })

        const textPart = result.parts.findLast((p: { type: string }) => p.type === "text")
        output = (textPart as { text: string } | undefined)?.text ?? "No response from multimodal agent"
      } catch (error) {
        if (timedOut) {
          output = `Timed out after ${timeout}s — the analysis took too long.`
        } else {
          throw error
        }
      } finally {
        clearTimeout(timer)
      }

      const attachments = params.show_to_user
        ? await Promise.all(files.map((file) => toVisibleAttachment(file, ctx)))
        : undefined

      if (files.length === 1) {
        return {
          title: timedOut ? "Analysis timed out" : `Analyzed: ${files[0].filename}`,
          output,
          metadata: {
            filePath: files[0].filepath,
            mimeType: files[0].mimeType,
            timeout,
            timedOut,
            shownToUser: params.show_to_user === true,
          },
          attachments,
        }
      }

      return {
        title: timedOut ? "Analysis timed out" : `Analyzed ${files.length} files`,
        output,
        metadata: {
          fileCount: files.length,
          timeout,
          timedOut,
          shownToUser: params.show_to_user === true,
        },
        attachments,
      }
    },
  }
})
