import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { AgoraClient, AgoraSSH, AgoraWorkspace } from "../agora"
import type { AgoraTypes } from "../agora"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agora-join.txt"

const parameters = z
  .object({
    post_id: z.string().describe("The project's post ID (from agora_search or agora_read)"),
    answer: z
      .string()
      .optional()
      .describe(
        "Your contribution proposal — what you plan to do. Creates a new answer and branch. Mutually exclusive with answer_id.",
      ),
    answer_id: z
      .string()
      .optional()
      .describe("An existing contribution's answer ID to clone its branch. Mutually exclusive with answer."),
    directory: z
      .string()
      .optional()
      .describe("Local directory for the workspace. Auto-generated from repo/branch name if omitted."),
  })
  .superRefine((data, ctx) => {
    if (data.answer && data.answer_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either 'answer' or 'answer_id', not both",
      })
    }
    if (!data.answer && !data.answer_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either 'answer' or 'answer_id' must be provided",
      })
    }
  })

interface AgoraJoinMetadata {
  answerId: string
  postId: string
  directory: string
  branch?: string
  repo?: string
}

function slugPart(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function defaultDirectory(repoName: string | undefined, branchName: string | undefined, answerId: string) {
  const repo = slugPart(repoName || "agora-repo") || "agora-repo"
  const branch = slugPart(branchName || answerId) || answerId
  return `${repo}-${branch}`
}

function extractCloneUrl(command?: string) {
  if (!command) return undefined
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const cloneIndex = parts.findIndex((part) => part === "clone")
  if (cloneIndex < 0) return undefined

  const args = parts.slice(cloneIndex + 1).map((part) => part.replace(/^(["'])(.*)\1$/, "$2"))
  for (let i = 0; i < args.length; i++) {
    const value = args[i]
    if (!value) continue
    if (value === "--") {
      return args[i + 1]
    }
    if (value.startsWith("-")) {
      if (
        [
          "-b",
          "--branch",
          "-o",
          "--origin",
          "-c",
          "--config",
          "-u",
          "--upload-pack",
          "-j",
          "--jobs",
          "--reference",
          "--separate-git-dir",
        ].includes(value)
      ) {
        i += 1
      }
      continue
    }
    return value
  }

  return undefined
}

async function exists(target: string) {
  return AgoraWorkspace.pathExists(target)
}

async function streamText(stream?: ReadableStream<Uint8Array> | null) {
  return AgoraWorkspace.streamText(stream)
}

function buildCloneCommand(cloneUrl: string, branch: string) {
  return `git clone --branch ${branch} --single-branch ${cloneUrl}`
}

export const AgoraJoinTool = Tool.define<typeof parameters, AgoraJoinMetadata>("agora_join", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    let answerId: string
    let branch: string
    let cloneUrl: string
    let repoName: string | undefined
    let postId = params.post_id

    if (params.answer) {
      const response = await AgoraClient.request<AgoraTypes.AnswerDetail>(
        "POST",
        `/api/posts/${params.post_id}/answers`,
        {
          body: { text: params.answer },
          abort: ctx.abort,
        },
      )

      answerId = response.id
      branch = response.branch_name!
      if (!branch) {
        throw new Error("Agora did not assign a branch for this answer")
      }

      const rawCloneUrl =
        response.branch_clone_url ?? extractCloneUrl(response.branch_clone_command ?? undefined) ?? undefined

      if (rawCloneUrl) {
        cloneUrl = rawCloneUrl
      } else {
        const repoInfo = await AgoraClient.request<AgoraTypes.RepoInfo>("GET", `/api/repos/${params.post_id}`, {
          abort: ctx.abort,
        })
        repoName = repoInfo.repo_name
        if (!repoInfo.repo?.ssh_url) {
          throw new Error("Agora answer does not expose a clone URL and the repository SSH URL is unavailable")
        }
        cloneUrl = repoInfo.repo.ssh_url
      }
    } else {
      const answer = await AgoraClient.request<AgoraTypes.AnswerDetail>("GET", `/api/answers/${params.answer_id}`, {
        abort: ctx.abort,
      })

      answerId = answer.id
      postId = answer.post_id
      branch = answer.branch_name!
      if (!branch) {
        throw new Error("Agora answer does not expose a branch name")
      }

      const repoInfo = await AgoraClient.request<AgoraTypes.RepoInfo>("GET", `/api/repos/${answer.post_id}`, {
        abort: ctx.abort,
      })
      repoName = repoInfo.repo_name

      cloneUrl =
        answer.branch_clone_url ?? extractCloneUrl(answer.branch_clone_command ?? undefined) ?? repoInfo.repo?.ssh_url!
      if (!cloneUrl) {
        throw new Error("Agora answer does not expose a clone URL and the repository SSH URL is unavailable")
      }
    }

    const post = await AgoraClient.request<AgoraTypes.PostDetail>("GET", `/api/posts/${postId}`, {
      abort: ctx.abort,
    })
    repoName = repoName ?? post.repo_name

    const directory = path.resolve(Instance.directory, params.directory ?? defaultDirectory(repoName, branch, answerId))
    const displayPath = path.relative(Instance.directory, directory)
    const permissionPath = Instance.contains(directory) ? displayPath || path.basename(directory) : directory

    if (await exists(directory)) {
      throw new Error(`Target path already exists: ${permissionPath}`)
    }

    if (!Instance.contains(directory)) {
      await ctx.ask({
        permission: "external_directory",
        patterns: [directory],
        metadata: {},
      })
    }

    await ctx.ask({
      permission: "edit",
      patterns: [permissionPath],
      metadata: {
        filepath: directory,
      },
    })

    await fs.mkdir(path.dirname(directory), { recursive: true })

    const access = await AgoraSSH.ensureAccess({ cloneUrl, abort: ctx.abort })
    const rewrittenCloneUrl = access.cloneUrl ?? cloneUrl
    const proc = Bun.spawn(["git", "clone", "--branch", branch, "--single-branch", rewrittenCloneUrl, directory], {
      cwd: Instance.directory,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: process.env,
    })

    let aborted = false
    const onAbort = () => {
      aborted = true
      proc.kill()
    }

    ctx.abort.addEventListener("abort", onAbort, { once: true })

    try {
      const exitCode = await proc.exited
      const [stdout, stderr] = await Promise.all([streamText(proc.stdout), streamText(proc.stderr)])

      if (aborted) {
        throw new Error("Agora join aborted")
      }

      if (exitCode !== 0) {
        throw new Error(`Git clone failed: ${stderr || stdout || `exit code ${exitCode}`}`)
      }

      await AgoraWorkspace.writeManifest(directory, {
        post_id: postId,
        answer_id: answerId,
        branch,
        repo: repoName,
        clone_url: cloneUrl,
      })

      const effectiveCloneCommand = buildCloneCommand(cloneUrl, branch)
      const output = [
        params.answer ? "Joined project with new contribution." : "Joined existing contribution.",
        "",
        `Directory: ${directory}`,
        `Repo: ${repoName ?? "unknown"}`,
        `Branch: ${branch}`,
        `Answer ID: ${answerId}`,
        `Clone URL: ${cloneUrl}`,
        `Clone command: ${effectiveCloneCommand}`,
        "",
        `Next: edit files in \`${displayPath || directory}\`, then use \`agora_submit\` to deliver your work.`,
      ].join("\n")

      return {
        title: `Joined: ${path.basename(directory)}`,
        output,
        metadata: {
          answerId,
          postId,
          directory,
          branch,
          repo: repoName,
        },
      }
    } finally {
      ctx.abort.removeEventListener("abort", onAbort)
    }
  },
})
