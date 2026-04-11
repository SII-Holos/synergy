import z from "zod"
import { Tool } from "./tool"
import { AgoraClient, AgoraWorkspace } from "../agora"
import { Log } from "@/util/log"
import DESCRIPTION from "./agora-submit.txt"

const log = Log.create({ service: "agora" })

const parameters = z.object({
  directory: z.string().describe("Path to an Agora workspace directory (created by agora_join, contains .agora.json)"),
  comment: z
    .string()
    .optional()
    .describe(
      "What you did — used as both the git commit message and the notification on the project thread. Auto-generated from changed files if omitted.",
    ),
})

interface AgoraSubmitMetadata {
  postId: string
  answerId: string
  branch: string
  directory: string
  commitCount: number
  commentPosted: boolean
}

export const AgoraSubmitTool = Tool.define<typeof parameters, AgoraSubmitMetadata>("agora_submit", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const manifest = await AgoraWorkspace.readManifest(params.directory)
    const { post_id, answer_id, branch } = manifest

    const merging = await AgoraWorkspace.isMergeInProgress(params.directory)

    if (merging) {
      const conflicts = await AgoraWorkspace.findConflictFiles(params.directory)
      if (conflicts.length > 0) {
        throw new Error(
          `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} still ha${conflicts.length === 1 ? "s" : "ve"} unresolved conflicts: ${conflicts.join(", ")}`,
        )
      }
      await AgoraWorkspace.gitOrFail(["add", "-A"], { cwd: params.directory, abort: ctx.abort })
      await AgoraWorkspace.gitOrFail(["commit", "--no-edit"], { cwd: params.directory, abort: ctx.abort })
    } else {
      const hasChanges = await AgoraWorkspace.hasStagedOrUntracked(params.directory)
      if (!hasChanges) {
        const unpushed = await countUnpushed(params.directory, branch, ctx.abort)
        if (unpushed === 0) {
          return {
            title: "Nothing to submit",
            output: "Nothing to submit — no local changes and no unpushed commits.",
            metadata: {
              postId: post_id,
              answerId: answer_id,
              branch,
              directory: params.directory,
              commitCount: 0,
              commentPosted: false,
            },
          }
        }
      } else {
        await AgoraWorkspace.gitOrFail(["add", "-A"], { cwd: params.directory, abort: ctx.abort })

        let message = params.comment
        if (!message) {
          const stat = await AgoraWorkspace.gitOrFail(["diff", "--cached", "--stat"], {
            cwd: params.directory,
            abort: ctx.abort,
          })
          const lines = stat.split("\n").filter(Boolean)
          const fileCount = Math.max(lines.length - 1, 1)
          message = `Update ${fileCount} file${fileCount === 1 ? "" : "s"}`
        }

        await AgoraWorkspace.gitOrFail(["commit", "-m", message], { cwd: params.directory, abort: ctx.abort })
      }
    }

    const pushResult = await AgoraWorkspace.git(["push", "origin", branch], {
      cwd: params.directory,
      abort: ctx.abort,
    })
    if (pushResult.exitCode !== 0) {
      const combined = `${pushResult.stderr}\n${pushResult.stdout}`.toLowerCase()
      if (combined.includes("rejected") || combined.includes("non-fast-forward")) {
        throw new Error(
          `Push rejected — the remote branch has new commits. Run agora_sync first to pull and merge, then agora_submit again.\n\n${pushResult.stderr || pushResult.stdout}`,
        )
      }
      throw new Error(
        `git push failed: ${pushResult.stderr || pushResult.stdout || `exit code ${pushResult.exitCode}`}`,
      )
    }

    const summaries = await AgoraWorkspace.commitSummary(params.directory)

    let notificationText: string
    if (params.comment) {
      notificationText = params.comment
    } else {
      const summaryList = summaries.slice(0, 5).join("; ")
      notificationText = summaries.length > 0 ? `Pushed to ${branch}: ${summaryList}` : `Pushed to ${branch}`
    }

    let commentPosted = false
    try {
      await AgoraClient.request("POST", `/api/posts/${post_id}/comments`, {
        body: {
          parent_type: "post",
          parent_id: post_id,
          content: notificationText,
        },
        abort: ctx.abort,
      })
      commentPosted = true
    } catch (err) {
      log.warn("failed to post agora notification comment", { post_id, error: err })
    }

    const output = [
      "Submitted successfully!",
      "",
      `Branch: ${branch}`,
      `Comment posted: ${commentPosted ? "yes" : "no (failed, non-blocking)"}`,
      summaries.length > 0 ? `\nRecent commits:\n${summaries.map((s) => `  ${s}`).join("\n")}` : undefined,
      "",
      "Use `agora_read` to check the project thread, or continue working and `agora_submit` again.",
    ]
      .filter((line) => line !== undefined)
      .join("\n")

    return {
      title: `Submitted to ${branch}`,
      output,
      metadata: {
        postId: post_id,
        answerId: answer_id,
        branch,
        directory: params.directory,
        commitCount: summaries.length,
        commentPosted,
      },
    }
  },
})

async function countUnpushed(directory: string, branch: string, abort?: AbortSignal): Promise<number> {
  const result = await AgoraWorkspace.git(["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: directory, abort })
  if (result.exitCode !== 0) return 0
  return parseInt(result.stdout, 10) || 0
}
