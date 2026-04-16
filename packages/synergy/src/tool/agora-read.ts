import z from "zod"
import { Tool } from "./tool"
import { AgoraClient } from "../agora"
import type { AgoraTypes } from "../agora"
import DESCRIPTION from "./agora-read.txt"

const parameters = z
  .object({
    post_id: z.string().describe("The project's post ID"),
    view: z
      .enum(["files", "file", "changes"])
      .optional()
      .describe(
        "Omit for full project overview (description, answers, comments, permissions). 'files' to browse the file tree. 'file' to read one file (requires path). 'changes' to see a contribution's diff (requires answer_id).",
      ),
    answer_id: z
      .string()
      .optional()
      .describe(
        "A contribution's answer ID. Required for 'changes' view. For 'files'/'file', browse that contribution's branch instead of main.",
      ),
    path: z
      .string()
      .optional()
      .describe(
        "File or directory path within the repo. Required for 'file'. Optional for 'files' (subdirectory) and 'changes' (filter diff).",
      ),
  })
  .superRefine((value, issue) => {
    if (value.view === "file" && !value.path) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "'path' is required when view is 'file'",
      })
    }
    if (value.view === "changes" && !value.answer_id) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer_id"],
        message: "'answer_id' is required when view is 'changes'",
      })
    }
  })

interface AgoraReadMetadata {
  postId: string
  view?: "files" | "file" | "changes"
  answerBranch?: string
  path?: string
}

function shortSha(value?: string | null) {
  return value?.slice(0, 8)
}

function firstLine(value?: string) {
  return value?.split("\n")[0]
}

function formatPermissions(permissions?: AgoraTypes.PostDetail["permissions"]): string {
  if (!permissions) return ""
  const allowed: string[] = []
  if (permissions.can_answer) allowed.push("answer")
  if (permissions.can_comment) allowed.push("comment")
  if (permissions.can_edit) allowed.push("edit")
  if (permissions.can_close) allowed.push("close")
  if (permissions.can_accept_answer) allowed.push("accept answer")
  if (allowed.length === 0) return ""
  return `You can: ${allowed.join(", ")}`
}

function formatComments(comments: AgoraTypes.Comment[]): string {
  if (comments.length === 0) return "No comments yet."
  return comments
    .map((comment) => {
      const indent = "  ".repeat(comment.depth)
      const prefix = comment.depth > 0 ? "↳ " : ""
      return `${indent}${prefix}[${comment.author_actor.display_name}] ${comment.content ?? ""}`
    })
    .join("\n")
}

function formatAnswers(answers: AgoraTypes.AnswerSummary[]): string {
  if (answers.length === 0) return "No answers yet."
  return answers
    .map((answer) => {
      const accepted = answer.is_accepted ? " ✓ ACCEPTED" : ""
      const text = answer.text ?? answer.text_preview ?? ""
      const gitLines = [
        answer.branch_name ? `Branch: ${answer.branch_name}` : undefined,
        answer.base_commit_sha ? `Base: ${shortSha(answer.base_commit_sha)}` : undefined,
        answer.head_commit_sha ? `Head: ${shortSha(answer.head_commit_sha)}` : undefined,
        answer.branch_clone_url ? `Clone URL: ${answer.branch_clone_url}` : undefined,
        answer.branch_clone_command ? `Clone: ${answer.branch_clone_command}` : undefined,
      ]
        .filter((line) => line !== undefined)
        .join("\n")
      return [
        `### Answer by ${answer.author_actor.display_name} (${answer.status}${accepted})`,
        text,
        `Answer ID: ${answer.id}`,
        gitLines,
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n\n")
}

function formatIdentity(identity?: AgoraTypes.CommitIdentity) {
  if (!identity?.name && !identity?.email) return "unknown"
  if (identity.name && identity.email) return `${identity.name} <${identity.email}>`
  return identity.name ?? identity.email ?? "unknown"
}

function formatCommit(commit: AgoraTypes.AnswerCommit) {
  const sha = shortSha(commit.sha) ?? "unknown"
  const message = firstLine(commit.message ?? commit.commit?.message) ?? "(no message)"
  const author = formatIdentity(commit.commit?.author ?? commit.author)
  const date = commit.commit?.author?.date ?? commit.created
  return [`- ${sha} ${message}`, `  Author: ${author}`, date ? `  Date: ${date}` : undefined].filter(Boolean).join("\n")
}

function matchesPath(pathFilter: string | undefined, filename: string | undefined) {
  if (!pathFilter || !filename) return true
  return filename === pathFilter || filename.startsWith(`${pathFilter}/`)
}

function decodeBlob(blob: AgoraTypes.BlobResponse) {
  const encoding = blob.encoding?.toLowerCase()
  if (encoding === "base64") {
    return Buffer.from(blob.content, "base64").toString("utf8")
  }
  return blob.content
}

async function resolveRef(
  answerId: string | undefined,
  abort: AbortSignal,
): Promise<AgoraTypes.AnswerDetail | undefined> {
  if (!answerId) return undefined
  return AgoraClient.request<AgoraTypes.AnswerDetail>("GET", `/api/answers/${answerId}`, { abort })
}

async function executeDefault(params: { post_id: string }, abort: AbortSignal) {
  const [post, answersData, commentsData] = await Promise.all([
    AgoraClient.request<AgoraTypes.PostDetail>("GET", `/api/posts/${params.post_id}`, { abort }),
    AgoraClient.request<{ items: AgoraTypes.AnswerSummary[] }>("GET", `/api/posts/${params.post_id}/answers`, {
      params: { limit: 50 },
      abort,
    }),
    AgoraClient.request<{ items: AgoraTypes.Comment[] }>("GET", `/api/posts/${params.post_id}/comments`, {
      params: { limit: 100 },
      abort,
    }),
  ])

  const answers = answersData.items ?? []
  const comments = commentsData.items ?? []

  const header = [
    `# ${post.title}`,
    "",
    `Status: ${post.status} | Author: ${post.author_actor.display_name} (${post.author_actor.actor_type})`,
    `Tags: ${post.tags.join(", ")}`,
    `Bounty: ${post.bounty} | Answers: ${answers.length} | Comments: ${comments.length}`,
    post.repo_name ? `Repo: ${post.repo_name}` : undefined,
    post.current_main_commit_sha ? `Current main: ${shortSha(post.current_main_commit_sha)}` : undefined,
    `Created: ${post.created_at}`,
  ].filter((line) => line !== undefined)

  const permissions = formatPermissions(post.permissions)
  if (permissions) header.push(permissions)

  const sections = [
    header.join("\n"),
    `## Description\n\n${post.description}`,
    `## Answers (${answers.length})\n\n${formatAnswers(answers)}`,
    `## Comments (${comments.length})\n\n${formatComments(comments)}`,
  ]

  const output = sections.join("\n\n")
  const truncatedTitle = post.title.length > 60 ? post.title.slice(0, 57) + "..." : post.title

  return {
    title: `Post: ${truncatedTitle}`,
    output,
    metadata: { postId: post.id },
  }
}

async function executeFiles(params: { post_id: string; answer_id?: string; path?: string }, abort: AbortSignal) {
  const [post, answer] = await Promise.all([
    AgoraClient.request<AgoraTypes.PostDetail>("GET", `/api/posts/${params.post_id}`, { abort }),
    resolveRef(params.answer_id, abort),
  ])

  const repo = post.repo_name
  if (!repo) throw new Error("Agora post does not expose a repository name")

  const ref = answer?.branch_name
  const data = await AgoraClient.request<AgoraTypes.TreeResponse>("GET", `/api/repos/${params.post_id}/tree`, {
    params: { ref, path: params.path ?? "" },
    abort,
  })

  const entries = data.items ?? data.tree ?? []
  const location = params.path || "."
  const headingRef = ref ? ` @ ${ref}` : ""

  const output = entries.length
    ? [
        `# Tree for ${repo}${headingRef}`,
        "",
        `Path: ${location}`,
        data.sha ? `Resolved SHA: ${shortSha(data.sha)}` : undefined,
        data.truncated ? "Note: tree listing is truncated." : undefined,
        "",
        ...entries.map((entry) => {
          const size = typeof entry.size === "number" ? ` (${entry.size} bytes)` : ""
          return `- [${entry.type}] ${entry.path}${size}`
        }),
      ]
        .filter(Boolean)
        .join("\n")
    : `Tree is empty for ${repo}${headingRef} at ${location}.`

  return {
    title: `Tree: ${repo}`,
    output,
    metadata: {
      postId: post.id,
      view: "files",
      answerBranch: ref,
      path: params.path,
    },
  }
}

async function executeFile(params: { post_id: string; answer_id?: string; path: string }, abort: AbortSignal) {
  const [post, answer] = await Promise.all([
    AgoraClient.request<AgoraTypes.PostDetail>("GET", `/api/posts/${params.post_id}`, { abort }),
    resolveRef(params.answer_id, abort),
  ])

  const repo = post.repo_name
  if (!repo) throw new Error("Agora post does not expose a repository name")

  const ref = answer?.branch_name
  const data = await AgoraClient.request<AgoraTypes.BlobResponse>("GET", `/api/repos/${params.post_id}/blob`, {
    params: { ref, path: params.path },
    abort,
  })

  const content = data.is_binary ? undefined : decodeBlob(data)
  const output = [
    `# ${params.path}`,
    "",
    `Repo: ${repo}`,
    ref ? `Ref: ${ref}` : undefined,
    data.sha ? `SHA: ${shortSha(data.sha)}` : undefined,
    typeof data.size === "number" ? `Size: ${data.size} bytes` : undefined,
    data.is_binary ? "Binary: true" : undefined,
    "",
    data.is_binary ? "Binary file content is omitted." : "```",
    data.is_binary ? undefined : content,
    data.is_binary ? undefined : "```",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  return {
    title: `Blob: ${params.path}`,
    output,
    metadata: {
      postId: post.id,
      view: "file",
      answerBranch: ref,
      path: params.path,
    },
  }
}

async function executeChanges(params: { post_id: string; answer_id: string; path?: string }, abort: AbortSignal) {
  const answer = await AgoraClient.request<AgoraTypes.AnswerDetail>("GET", `/api/answers/${params.answer_id}`, {
    abort,
  })

  const branch = answer.branch_name

  const [commitsData, diff] = await Promise.all([
    AgoraClient.request<AgoraTypes.AnswerCommitListResponse>("GET", `/api/answers/${params.answer_id}/commits`, {
      abort,
    }),
    AgoraClient.request<AgoraTypes.DiffResponse>("GET", `/api/answers/${params.answer_id}/diff`, {
      params: { path: params.path },
      abort,
    }),
  ])

  const commits = commitsData.items ?? []
  const files = (diff.files ?? []).filter((file) => matchesPath(params.path, file.new_name ?? file.old_name))

  const output = [
    `# Changes for answer ${answer.id}`,
    "",
    branch ? `Branch: ${branch}` : undefined,
    diff.base_commit_sha ? `Base: ${shortSha(diff.base_commit_sha)}` : undefined,
    diff.head_commit_sha ? `Head: ${shortSha(diff.head_commit_sha)}` : undefined,
    params.path ? `Path filter: ${params.path}` : undefined,
    "",
    commits.length ? ["## Commits", "", ...commits.map(formatCommit)].join("\n") : "## Commits\n\nNo commits found.",
    "",
    files.length
      ? [
          "## Files",
          "",
          ...files.map((file) => {
            const name = file.new_name ?? file.old_name ?? "unknown"
            const stats = [
              file.is_created ? "created" : undefined,
              file.is_deleted ? "deleted" : undefined,
              file.is_rename ? "renamed" : undefined,
              typeof file.additions === "number" ? `+${file.additions}` : undefined,
              typeof file.deletions === "number" ? `-${file.deletions}` : undefined,
            ]
              .filter(Boolean)
              .join(" | ")
            const patch = file.patch ? `\n\n\`\`\`diff\n${file.patch}\n\`\`\`` : ""
            return `### ${name}${stats ? `\n${stats}` : ""}${patch}`
          }),
        ].join("\n")
      : diff.patch
        ? `## Patch\n\n\`\`\`diff\n${diff.patch}\n\`\`\``
        : "## Files\n\nNo diff files reported.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  return {
    title: `Changes: ${branch ?? answer.id}`,
    output,
    metadata: {
      postId: answer.post_id,
      view: "changes",
      answerBranch: branch,
      path: params.path,
    },
  }
}

export const AgoraReadTool = Tool.define<typeof parameters, AgoraReadMetadata>("agora_read", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    if (!params.view) {
      return executeDefault(params, ctx.abort)
    }
    if (params.view === "files") {
      return executeFiles(params, ctx.abort)
    }
    if (params.view === "file") {
      return executeFile(params as { post_id: string; answer_id?: string; path: string }, ctx.abort)
    }
    return executeChanges(params as { post_id: string; answer_id: string; path?: string }, ctx.abort)
  },
})
