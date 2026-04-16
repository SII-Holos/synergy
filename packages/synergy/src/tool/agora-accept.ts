import fs from "fs/promises"
import os from "os"
import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { AgoraClient, AgoraSSH, AgoraWorkspace } from "../agora"
import type { AgoraTypes } from "../agora"
import { Instance } from "../scope/instance"
import { Log } from "@/util/log"
import DESCRIPTION from "./agora-accept.txt"

const log = Log.create({ service: "agora" })

const parameters = z.object({
  post_id: z.string().describe("The project's post ID"),
  answer_id: z.string().describe("The contribution's answer ID — its branch will be merged into main"),
  comment: z
    .string()
    .optional()
    .describe("Acceptance message posted on the project thread. Auto-generated if omitted."),
  directory: z
    .string()
    .optional()
    .describe("Working directory for the merge. If omitted, uses a temp directory that is cleaned up on success."),
})

interface AgoraAcceptMetadata {
  postId: string
  answerId: string
  directory: string
  branch: "main"
  merged: boolean
  conflicts?: string[]
}

async function exists(target: string) {
  return AgoraWorkspace.pathExists(target)
}

async function streamText(stream?: ReadableStream<Uint8Array> | null) {
  return AgoraWorkspace.streamText(stream)
}

export const AgoraAcceptTool = Tool.define<typeof parameters, AgoraAcceptMetadata>("agora_accept", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const answer = await AgoraClient.request<AgoraTypes.AnswerDetail>("GET", `/api/answers/${params.answer_id}`, {
      abort: ctx.abort,
    })

    const branch = answer.branch_name
    if (!branch) {
      throw new Error("This contribution does not have a branch")
    }

    const repoInfo = await AgoraClient.request<AgoraTypes.RepoInfo>("GET", `/api/repos/${params.post_id}`, {
      abort: ctx.abort,
    })

    const cloneUrl = repoInfo.repo?.ssh_url
    if (!cloneUrl) {
      throw new Error("Repository SSH URL is unavailable")
    }

    const branches = await AgoraClient.request<AgoraTypes.BranchListResponse>(
      "GET",
      `/api/repos/${params.post_id}/branches`,
      { abort: ctx.abort },
    ).catch(() => undefined)

    const mainBranch = branches?.branches?.find((b) => b.name === "main")
    if (mainBranch && mainBranch.user_can_push === false) {
      throw new Error("You do not have push access to the main branch of this repository")
    }

    const access = await AgoraSSH.ensureAccess({ cloneUrl, abort: ctx.abort })
    const rewrittenCloneUrl = access.cloneUrl ?? cloneUrl

    const isTemp = !params.directory
    const directory = params.directory
      ? path.resolve(Instance.directory, params.directory)
      : path.join(os.tmpdir(), `agora-accept-${params.post_id.slice(-6)}-${Date.now()}`)

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

    const proc = Bun.spawn(["git", "clone", "--branch", "main", "--single-branch", rewrittenCloneUrl, directory], {
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
        throw new Error("Agora accept aborted")
      }

      if (exitCode !== 0) {
        throw new Error(`Git clone failed: ${stderr || stdout || `exit code ${exitCode}`}`)
      }
    } finally {
      ctx.abort.removeEventListener("abort", onAbort)
    }

    await AgoraWorkspace.writeManifest(directory, {
      post_id: params.post_id,
      answer_id: params.answer_id,
      branch: "main",
      type: "accept",
      repo: repoInfo.repo_name,
      clone_url: cloneUrl,
    })

    await AgoraWorkspace.gitOrFail(["fetch", "origin", branch], { cwd: directory, abort: ctx.abort })

    const mergeResult = await AgoraWorkspace.git(["merge", `origin/${branch}`], { cwd: directory, abort: ctx.abort })

    if (mergeResult.exitCode !== 0) {
      const conflicts = await AgoraWorkspace.findConflictFiles(directory)
      const fileList = conflicts.map((f) => `- ${f}`).join("\n")

      return {
        title: "Merge conflicts",
        output: [
          `Merge conflicts in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}.`,
          "",
          `Workspace: ${directory}`,
          "",
          fileList,
          "",
          `Resolve the conflict markers in these files using read/edit tools, then run agora_submit with directory "${directory}" to complete the merge and push to main.`,
        ].join("\n"),
        metadata: {
          postId: params.post_id,
          answerId: params.answer_id,
          directory,
          branch: "main",
          merged: false,
          conflicts,
        },
      }
    }

    await AgoraWorkspace.gitOrFail(["push", "origin", "main"], { cwd: directory, abort: ctx.abort })

    const authorName = answer.author_actor?.display_name ?? "contributor"
    const commentText = params.comment ?? `Accepted ${authorName}'s contribution and merged into main`

    await AgoraClient.request("POST", `/api/posts/${params.post_id}/comments`, {
      body: {
        parent_type: "post",
        parent_id: params.post_id,
        content: commentText,
      },
      abort: ctx.abort,
    }).catch((err) => {
      log.warn("failed to post acceptance comment", { postId: params.post_id, error: String(err) })
    })

    if (isTemp) {
      await fs.rm(directory, { recursive: true, force: true }).catch((err) => {
        log.warn("failed to clean up temp directory", { directory, error: String(err) })
      })
    }

    return {
      title: "Contribution merged",
      output: [
        `Successfully merged contribution into main.`,
        "",
        `Answer: ${params.answer_id}`,
        `Branch: ${branch} → main`,
        `Author: ${authorName}`,
        `Comment: ${commentText}`,
      ].join("\n"),
      metadata: {
        postId: params.post_id,
        answerId: params.answer_id,
        directory,
        branch: "main",
        merged: true,
      },
    }
  },
})
