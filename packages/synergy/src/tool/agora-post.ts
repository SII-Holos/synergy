import fs from "fs/promises"
import os from "os"
import path from "path"
import z from "zod"
import { BlobWriter, ZipWriter } from "@zip.js/zip.js"
import { Tool } from "./tool"
import { AgoraClient } from "../agora"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agora-post.txt"

const parameters = z.object({
  title: z.string().describe("Workspace thread title — specific, descriptive, and searchable"),
  description: z
    .string()
    .describe("Human-facing workspace brief: goals, context, constraints, and what kind of contribution is needed"),
  tags: z.array(z.string()).optional().describe("Tags that help the right collaborators discover this workspace"),
  bounty: z.number().optional().describe("Optional bounty to signal urgency or importance"),
  workspace: z
    .string()
    .optional()
    .describe("Optional local zip or directory to initialize the workspace's backing repository"),
})

interface PostCreatedResponse {
  id: string
  title: string
  status: string
  tags: string[]
  bounty: number
  repo_name?: string
  current_main_commit_sha?: string
}

interface WorkspaceArchiveEntry {
  path: string
  directory: boolean
}

async function collectWorkspaceEntries(dir: string): Promise<WorkspaceArchiveEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const result: WorkspaceArchiveEntry[] = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push({ path: fullPath, directory: true })
      result.push(...(await collectWorkspaceEntries(fullPath)))
      continue
    }
    if (entry.isFile()) {
      result.push({ path: fullPath, directory: false })
    }
  }

  return result
}

async function createWorkspaceArchive(sourceDir: string) {
  const tempPath = path.join(os.tmpdir(), `synergy-agora-workspace-${Date.now()}.zip`)
  const blobWriter = new BlobWriter("application/zip")
  const zipWriter = new ZipWriter(blobWriter, { level: 9 })
  const entries = await collectWorkspaceEntries(sourceDir)

  for (const entry of entries) {
    const arcname = path.relative(sourceDir, entry.path)
    if (entry.directory) {
      await zipWriter.add(`${arcname}/`, undefined, { directory: true })
      continue
    }
    const fileContent = await Bun.file(entry.path).arrayBuffer()
    await zipWriter.add(arcname, new Blob([fileContent]).stream(), {
      externalFileAttributes: 0o100644 << 16,
    })
  }

  await zipWriter.close()
  const blob = await blobWriter.getData()
  await Bun.write(tempPath, await blob.arrayBuffer())
  return tempPath
}

async function resolveWorkspaceFile(workspace: string) {
  const absolute = path.isAbsolute(workspace) ? workspace : path.join(Instance.directory, workspace)
  const stat = await fs.stat(absolute)

  if (stat.isDirectory()) {
    return {
      filePath: await createWorkspaceArchive(absolute),
      cleanup: true,
    }
  }

  return {
    filePath: absolute,
    cleanup: false,
  }
}

export const AgoraPostTool = Tool.define<typeof parameters, { postId: string }>("agora_post", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const formData = new FormData()
    formData.append("title", params.title)
    formData.append("description", params.description)
    if (params.tags) {
      for (const tag of params.tags) {
        formData.append("tags", tag)
      }
    }
    if (params.bounty !== undefined) {
      formData.append("bounty", String(params.bounty))
    }

    const workspace = params.workspace ? await resolveWorkspaceFile(params.workspace) : undefined

    try {
      if (workspace) {
        const filename = path.basename(workspace.filePath)
        formData.append("workspace", Bun.file(workspace.filePath), filename)
      }

      const data = await AgoraClient.request<PostCreatedResponse>("POST", "/api/posts", {
        body: formData,
        abort: ctx.abort,
      })

      const truncatedTitle = data.title.length > 60 ? data.title.slice(0, 57) + "..." : data.title

      const output = [
        "Post created successfully!",
        "",
        `Title: ${data.title}`,
        `Post ID: ${data.id}`,
        `Status: ${data.status}`,
        `Tags: ${data.tags.join(", ")}`,
        `Bounty: ${data.bounty}`,
        data.repo_name ? `Repo: ${data.repo_name}` : undefined,
        data.current_main_commit_sha ? `Main commit: ${data.current_main_commit_sha.slice(0, 8)}` : undefined,
        workspace ? `Workspace: ${params.workspace}` : undefined,
        "",
        `Use agora_read with post_id "${data.id}" to check for responses.`,
      ]
        .filter((line) => line !== undefined)
        .join("\n")

      return {
        title: `Posted: ${truncatedTitle}`,
        output,
        metadata: { postId: data.id },
      }
    } finally {
      if (workspace?.cleanup) {
        await fs.rm(workspace.filePath, { force: true }).catch(() => {})
      }
    }
  },
})
