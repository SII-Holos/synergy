import z from "zod"
import { Tool } from "./tool"
import { AgoraClient, AgoraWorkspace } from "../agora"
import type { AgoraTypes } from "../agora"
import DESCRIPTION from "./agora-sync.txt"

const parameters = z.object({
  directory: z.string().describe("Path to an Agora workspace directory (created by agora_join, contains .agora.json)"),
  answer_id: z
    .string()
    .optional()
    .describe(
      "Merge a specific contribution's branch into your workspace. If omitted, merges the main branch instead.",
    ),
})

interface AgoraSyncMetadata {
  postId: string
  directory: string
  source: string
  synced: boolean
  newCommits?: number
  conflicts?: string[]
}

async function countCommitsBetween(from: string, to: string, directory: string, abort?: AbortSignal): Promise<number> {
  const output = await AgoraWorkspace.gitOrFail(["rev-list", "--count", `${from}..${to}`], { cwd: directory, abort })
  return parseInt(output, 10) || 0
}

export const AgoraSyncTool = Tool.define<typeof parameters, AgoraSyncMetadata>("agora_sync", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const manifest = await AgoraWorkspace.readManifest(params.directory)

    if (params.answer_id) {
      const answer = await AgoraClient.request<AgoraTypes.AnswerDetail>("GET", `/api/answers/${params.answer_id}`, {
        abort: ctx.abort,
      })

      const targetBranch = answer.branch_name
      if (!targetBranch) {
        throw new Error("The specified answer does not have a branch name")
      }

      await AgoraWorkspace.gitOrFail(["fetch", "origin"], { cwd: params.directory, abort: ctx.abort })

      const headBefore = await AgoraWorkspace.gitOrFail(["rev-parse", "HEAD"], { cwd: params.directory })

      const mergeResult = await AgoraWorkspace.git(["merge", `origin/${targetBranch}`], {
        cwd: params.directory,
        abort: ctx.abort,
      })

      if (mergeResult.exitCode !== 0) {
        const conflicts = await AgoraWorkspace.findConflictFiles(params.directory)
        if (conflicts.length > 0) {
          const fileList = conflicts.map((f) => `- ${f}`).join("\n")
          return {
            title: "Sync conflict",
            output: `${conflicts.length} file${conflicts.length === 1 ? " has" : "s have"} conflicts. Resolve the conflict markers in these files, then call agora_submit to complete:\n\n${fileList}`,
            metadata: {
              postId: manifest.post_id,
              directory: params.directory,
              source: `answer:${params.answer_id}`,
              synced: false,
              conflicts,
            },
          }
        }
        throw new Error(`git merge origin/${targetBranch} failed: ${mergeResult.stderr || mergeResult.stdout}`)
      }

      const newCommits = await countCommitsBetween(headBefore, "HEAD", params.directory, ctx.abort)

      return {
        title: `Merged contribution`,
        output: `Merged contribution — ${newCommits} new commit${newCommits === 1 ? "" : "s"} merged into your workspace.`,
        metadata: {
          postId: manifest.post_id,
          directory: params.directory,
          source: `answer:${params.answer_id}`,
          synced: true,
          newCommits,
        },
      }
    }

    await AgoraWorkspace.gitOrFail(["fetch", "origin"], { cwd: params.directory, abort: ctx.abort })

    const ahead = await countCommitsBetween("HEAD", "origin/main", params.directory, ctx.abort)

    if (ahead === 0) {
      return {
        title: "Already up to date",
        output: "Already up to date with main.",
        metadata: {
          postId: manifest.post_id,
          directory: params.directory,
          source: "main",
          synced: true,
          newCommits: 0,
        },
      }
    }

    const headBefore = await AgoraWorkspace.gitOrFail(["rev-parse", "HEAD"], { cwd: params.directory })

    const mergeResult = await AgoraWorkspace.git(["merge", "origin/main"], {
      cwd: params.directory,
      abort: ctx.abort,
    })

    if (mergeResult.exitCode !== 0) {
      const conflicts = await AgoraWorkspace.findConflictFiles(params.directory)
      if (conflicts.length > 0) {
        const fileList = conflicts.map((f) => `- ${f}`).join("\n")
        return {
          title: "Sync conflict",
          output: `${conflicts.length} file${conflicts.length === 1 ? " has" : "s have"} conflicts. Resolve the conflict markers in these files, then call agora_submit to complete:\n\n${fileList}`,
          metadata: {
            postId: manifest.post_id,
            directory: params.directory,
            source: "main",
            synced: false,
            conflicts,
          },
        }
      }
      throw new Error(`git merge origin/main failed: ${mergeResult.stderr || mergeResult.stdout}`)
    }

    const newCommits = await countCommitsBetween(headBefore, "HEAD", params.directory, ctx.abort)

    return {
      title: "Synced with main",
      output: `Synced with main — ${newCommits} new commit${newCommits === 1 ? "" : "s"} merged into your workspace.`,
      metadata: {
        postId: manifest.post_id,
        directory: params.directory,
        source: "main",
        synced: true,
        newCommits,
      },
    }
  },
})
