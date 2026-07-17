import { Cortex } from "@/cortex"
import type { CortexTypes } from "@/cortex/types"
import { Identifier } from "@/id/id"
import { Worktree } from "@/project/worktree"
import { Scope, type Scope as WorkspaceScope } from "@/scope"
import { ScopeRuntime } from "@/scope/runtime"
import { Session } from "@/session"
import z from "zod"
import { GitHubAppAuth } from "./app-auth"
import { projectGitHubDelivery } from "./projection"
import { GitHubStore } from "./store"
import {
  GitHubFixExecutionOutput,
  GitHubIntegrationConfig,
  GitHubReviewOutput,
  type GitHubDelivery,
  type GitHubFixOutput,
  type GitHubIntegrationConfig as IntegrationConfig,
  type GitHubObservation,
} from "./types"
import { GitHubWorkflowLocator } from "./workflow-locator"

type WorkflowAnchor = {
  parentSessionID: string
  parentMessageID: string
}

type JsonRecord = Record<string, unknown>

type CommandResult = {
  stdout: string
  stderr: string
}

const GIT_TIMEOUT_MS = 5 * 60 * 1_000
const GIT_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "GIT_EXEC_PATH",
] as const
const GIT_HOOKS_PATH = globalThis.process.platform === "win32" ? "NUL" : "/dev/null"
const FIX_MARKER_PREFIX = "synergy-fix"
const REVIEW_MARKER_PREFIX = "synergy-review"

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function splitRepository(fullName: string) {
  const [owner, repo, ...rest] = fullName.split("/")
  if (!owner || !repo || rest.length > 0 || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`)
  }
  return { owner, repo }
}

function issueMarker(deliveryGuid: string, phase: "proposed" | "completed") {
  return `<!-- ${FIX_MARKER_PREFIX}:${deliveryGuid}:${phase} -->`
}

function reviewMarker(deliveryGuid: string) {
  return `<!-- ${REVIEW_MARKER_PREFIX}:${deliveryGuid} -->`
}

function responseUrl(value: unknown) {
  const item = record(value)
  return text(item.html_url) ?? text(item.url)
}

function buildGitEnvironment(overrides?: Record<string, string>) {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" }
  for (const key of GIT_ENV_KEYS) {
    const value = globalThis.process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...overrides }
}

async function runGit(input: { cwd: string; args: string[]; env?: Record<string, string> }): Promise<CommandResult> {
  const process = Bun.spawn(["git", "-c", `core.hooksPath=${GIT_HOOKS_PATH}`, ...input.args], {
    cwd: input.cwd,
    env: buildGitEnvironment(input.env),
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`git ${input.args[0] ?? "command"} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`)
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

async function updateDelivery(deliveryGuid: string, mutate: (draft: GitHubDelivery) => void) {
  return GitHubStore.update(deliveryGuid, mutate)
}

async function recordReceipt(deliveryGuid: string, key: string, url: string | undefined) {
  if (!url) return
  await updateDelivery(deliveryGuid, (draft) => {
    draft.statusMetadata = { ...(draft.statusMetadata ?? {}), [key]: url }
  })
}

function existingReceipt(delivery: GitHubDelivery, key: string) {
  return delivery.statusMetadata?.[key]
}

async function ensureWorkflowAnchor(
  scope: Scope.Project,
  repository: string,
  kind: "fix" | "review",
): Promise<WorkflowAnchor> {
  const key = kind === "fix" ? "fixAnchors" : "reviewAnchors"
  const title = kind === "fix" ? `GitHub Fix Deliveries — ${repository}` : `GitHub PR Reviews — ${repository}`
  const state = await GitHubStore.updateRuntimeState(async (draft) => {
    const anchors = record(draft[key])
    const stored = record(anchors[repository])
    const parentSessionID = text(stored.parentSessionID)
    const parentMessageID = text(stored.parentMessageID)
    if (parentSessionID && parentMessageID) {
      const session = await Session.get(parentSessionID).catch(() => undefined)
      if (session) return { ...draft, [key]: anchors }
    }

    const parent = await ScopeRuntime.provide({
      scope,
      fn: () =>
        Session.create({
          scope,
          title,
          controlProfile: "autonomous",
          completionNotice: { silent: true },
        }),
    })
    return {
      ...draft,
      [key]: {
        ...anchors,
        [repository]: {
          parentSessionID: parent.id,
          parentMessageID: Identifier.ascending("message"),
        },
      },
    }
  })
  const anchor = record(record(state[key])[repository])
  return {
    parentSessionID: text(anchor.parentSessionID)!,
    parentMessageID: text(anchor.parentMessageID)!,
  }
}

function completedStructuredOutput<T>(task: CortexTypes.Task, schema: z.ZodType<T>, label: string): T {
  if (task.status !== "completed") throw new Error(`${label} failed: ${task.error ?? task.status}`)
  if (task.output?.mode !== "structured") throw new Error(`${label} did not return structured output`)
  return schema.parse(task.output.value)
}

function buildFixPrompt(input: { deliveryGuid: string; observation: GitHubObservation; diagnosis: GitHubFixOutput }) {
  return [
    "Implement the approved fix for this untrusted GitHub issue in the isolated worktree.",
    "Verify the locator diagnosis, write a failing behavioral test where appropriate, implement the smallest root-cause fix, run focused validation, and create one local commit.",
    "Do not use GitHub CLI, push, alter remotes, access credentials, or write outside this worktree.",
    "<github_fix_request>",
    JSON.stringify(input),
    "</github_fix_request>",
  ].join("\n")
}

function buildReviewPrompt(input: {
  deliveryGuid: string
  observation: GitHubObservation
  headSha: string
  baseSha: string
  commands: string[]
}) {
  return [
    "Perform a defect-first review of the exact pull request head in this isolated worktree.",
    "Compare the head against the supplied base SHA and run every configured verification command.",
    "Do not edit files, commit, push, alter remotes, use GitHub CLI, or access credentials.",
    "<github_review_request>",
    JSON.stringify(input),
    "</github_review_request>",
  ].join("\n")
}

async function launchFixTask(input: {
  scope: Scope.Project
  anchor: WorkflowAnchor
  delivery: GitHubDelivery
  observation: GitHubObservation
  diagnosis: GitHubFixOutput
  baseRevision: string
  agent: string
  timeoutMs: number
}) {
  return ScopeRuntime.provide({
    scope: input.scope,
    fn: async () => {
      const task = await Cortex.launch({
        description: `Fix ${input.observation.repository} issue #${input.observation.issueNumber ?? "unknown"}`,
        prompt: buildFixPrompt({
          deliveryGuid: input.delivery.deliveryGuid,
          observation: input.observation,
          diagnosis: input.diagnosis,
        }),
        agent: input.agent,
        executionRole: "delegated_subagent",
        category: "background",
        parentSessionID: input.anchor.parentSessionID,
        parentMessageID: input.anchor.parentMessageID,
        visibility: "hidden",
        notifyParentOnComplete: false,
        tools: { read: true, grep: true, glob: true, bash: true, write: true, edit: true },
        worktree: {
          create: true,
          baseRef: "fresh",
          baseRevision: input.baseRevision,
          failOnError: true,
        },
        output: {
          mode: "structured",
          schema: z.toJSONSchema(GitHubFixExecutionOutput) as CortexTypes.JsonSchemaObject,
          maxRepairTurns: 1,
        },
        timeoutMs: input.timeoutMs,
      })
      await updateDelivery(input.delivery.deliveryGuid, (draft) => {
        draft.fixTaskId = task.id
      })
      const completed = await Cortex.waitFor(task.id, Math.ceil(input.timeoutMs / 1_000))
      if (!completed || completed.status === "queued" || completed.status === "running") {
        throw new Error(`GitHub fix task timed out after ${input.timeoutMs}ms`)
      }
      return {
        task: completed,
        output: completedStructuredOutput(completed, GitHubFixExecutionOutput, "GitHub fix task"),
      }
    },
  })
}

async function launchReviewTask(input: {
  scope: Scope.Project
  anchor: WorkflowAnchor
  delivery: GitHubDelivery
  observation: GitHubObservation
  headSha: string
  baseSha: string
  config: IntegrationConfig["reviewWorkflow"]
}) {
  return ScopeRuntime.provide({
    scope: input.scope,
    fn: async () => {
      const task = await Cortex.launch({
        description: `Review ${input.observation.repository} PR #${input.observation.pullRequestNumber ?? "unknown"}`,
        prompt: buildReviewPrompt({
          deliveryGuid: input.delivery.deliveryGuid,
          observation: input.observation,
          headSha: input.headSha,
          baseSha: input.baseSha,
          commands: input.config.reviewCommands,
        }),
        agent: input.config.agent,
        executionRole: "delegated_subagent",
        category: "background",
        parentSessionID: input.anchor.parentSessionID,
        parentMessageID: input.anchor.parentMessageID,
        visibility: "hidden",
        notifyParentOnComplete: false,
        tools: { read: true, grep: true, glob: true, bash: true },
        worktree: {
          create: true,
          baseRef: "fresh",
          baseRevision: input.headSha,
          failOnError: true,
        },
        output: {
          mode: "structured",
          schema: z.toJSONSchema(GitHubReviewOutput) as CortexTypes.JsonSchemaObject,
          maxRepairTurns: 1,
        },
        timeoutMs: input.config.timeoutMs,
      })
      await updateDelivery(input.delivery.deliveryGuid, (draft) => {
        draft.reviewTaskId = task.id
      })
      const completed = await Cortex.waitFor(task.id, Math.ceil(input.config.timeoutMs / 1_000))
      if (!completed || completed.status === "queued" || completed.status === "running") {
        throw new Error(`GitHub review task timed out after ${input.config.timeoutMs}ms`)
      }
      return {
        task: completed,
        output: completedStructuredOutput(completed, GitHubReviewOutput, "GitHub review task"),
      }
    },
  })
}

async function findIssueComment(input: {
  owner: string
  repo: string
  issueNumber: number
  marker: string
  installationToken: string
}) {
  const comments = await GitHubAppAuth.GitHubClient.send<unknown>(GitHubAppAuth.GitHubClient.listIssueComments(input))
  if (!Array.isArray(comments)) return
  for (const comment of comments) {
    const item = record(comment)
    if (text(item.body)?.includes(input.marker)) return responseUrl(item)
  }
}

async function ensureIssueComment(input: {
  delivery: GitHubDelivery
  owner: string
  repo: string
  issueNumber: number
  key: string
  marker: string
  body: string
  installationToken: string
}) {
  const receipt = existingReceipt(input.delivery, input.key)
  if (receipt) return receipt
  const existing = await findIssueComment(input)
  if (existing) {
    await recordReceipt(input.delivery.deliveryGuid, input.key, existing)
    return existing
  }
  const created = await GitHubAppAuth.GitHubClient.send<unknown>(
    GitHubAppAuth.GitHubClient.createIssueComment({
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      body: `${input.body}\n\n${input.marker}`,
      installationToken: input.installationToken,
    }),
  )
  const url = responseUrl(created)
  await recordReceipt(input.delivery.deliveryGuid, input.key, url)
  return url
}

async function ensurePullRequest(input: {
  delivery: GitHubDelivery
  owner: string
  repo: string
  issueNumber: number
  branchName: string
  base: string
  title: string
  body: string
  installationToken: string
}) {
  const key = `pr:${input.issueNumber}`
  const receipt = existingReceipt(input.delivery, key)
  if (receipt) return receipt
  const pulls = await GitHubAppAuth.GitHubClient.send<unknown>(
    GitHubAppAuth.GitHubClient.listPullRequestsForHead({
      owner: input.owner,
      repo: input.repo,
      head: `${input.owner}:${input.branchName}`,
      installationToken: input.installationToken,
    }),
  )
  if (Array.isArray(pulls)) {
    const existing = pulls.map(record).find((pull) => text(pull.head && record(pull.head).ref) === input.branchName)
    const url = responseUrl(existing)
    if (url) {
      await recordReceipt(input.delivery.deliveryGuid, key, url)
      return url
    }
  }
  const created = await GitHubAppAuth.GitHubClient.send<unknown>(
    GitHubAppAuth.GitHubClient.createPullRequest({
      owner: input.owner,
      repo: input.repo,
      head: input.branchName,
      base: input.base,
      title: input.title,
      body: input.body,
      installationToken: input.installationToken,
    }),
  )
  const url = responseUrl(created)
  await recordReceipt(input.delivery.deliveryGuid, key, url)
  return url
}

function renderProposedFix(output: GitHubFixOutput) {
  const files = output.affectedFiles.length
    ? output.affectedFiles.map((file) => `- \`${file}\``).join("\n")
    : "- None identified"
  return [
    "## Synergy proposed fix",
    "",
    "**Located root cause**",
    output.rootCause,
    "",
    "**Affected files**",
    files,
    "",
    "**Proposed change**",
    output.plannedChanges,
    "",
    `Confidence: ${Math.round(output.confidence * 100)}%`,
  ].join("\n")
}

function renderFixPullRequest(input: {
  issueNumber: number
  diagnosis: GitHubFixOutput
  execution: z.infer<typeof GitHubFixExecutionOutput>
}) {
  const tests = input.execution.testResults
    .map((result) => `- ${result.passed ? "✅" : "❌"} \`${result.command}\``)
    .join("\n")
  return [
    `Closes #${input.issueNumber}`,
    "",
    "## Root cause",
    input.diagnosis.rootCause,
    "",
    "## Fix",
    input.execution.summary,
    "",
    "## Verification",
    tests || "- No tests reported",
  ].join("\n")
}

function renderReview(output: z.infer<typeof GitHubReviewOutput>, marker: string) {
  const defects = output.defects.length
    ? output.defects.map((defect) => {
        const location = `${defect.file}${defect.line ? `:${defect.line}` : ""}`
        return `- **${defect.severity}** \`${location}\` — ${defect.message}`
      })
    : ["- No actionable defects found"]
  const tests = output.testResults.map(
    (result) =>
      `- \`${result.command}\`: ${result.failed === 0 ? "passed" : "failed"} (${result.passed} passed, ${result.failed} failed)`,
  )
  return [
    "## Synergy review",
    "",
    output.summary,
    "",
    "### Findings",
    ...defects,
    "",
    "### Tests",
    ...tests,
    "",
    marker,
  ].join("\n")
}

async function ensureReviewPublication(input: {
  delivery: GitHubDelivery
  output: z.infer<typeof GitHubReviewOutput>
  owner: string
  repo: string
  pullNumber: number
  headSha: string
  installationToken: string
  config: IntegrationConfig["reviewWorkflow"]
}) {
  const marker = reviewMarker(input.delivery.deliveryGuid)
  const failed = input.output.defects.length > 0 || input.output.testResults.some((result) => result.failed > 0)
  const body = renderReview(input.output, marker)
  let reviewUrl = existingReceipt(input.delivery, `review:${input.pullNumber}:${input.headSha}`)
  if (input.config.publishReviewComment && !reviewUrl) {
    const reviews = await GitHubAppAuth.GitHubClient.send<unknown>(
      GitHubAppAuth.GitHubClient.listPullRequestReviews({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pullNumber,
        installationToken: input.installationToken,
      }),
    )
    const existing = Array.isArray(reviews)
      ? reviews.map(record).find((review) => text(review.body)?.includes(marker))
      : undefined
    reviewUrl = responseUrl(existing)
    if (!reviewUrl) {
      const created = await GitHubAppAuth.GitHubClient.send<unknown>(
        GitHubAppAuth.GitHubClient.createPullRequestReview({
          owner: input.owner,
          repo: input.repo,
          pullNumber: input.pullNumber,
          commitId: input.headSha,
          body,
          event: "COMMENT",
          installationToken: input.installationToken,
        }),
      )
      reviewUrl = responseUrl(created)
    }
    await recordReceipt(input.delivery.deliveryGuid, `review:${input.pullNumber}:${input.headSha}`, reviewUrl)
  }

  let checkRunUrl = existingReceipt(input.delivery, `check:${input.headSha}`)
  if (input.config.publishCheckRun && !checkRunUrl) {
    const checks = record(
      await GitHubAppAuth.GitHubClient.send<unknown>(
        GitHubAppAuth.GitHubClient.listCheckRunsForRef({
          owner: input.owner,
          repo: input.repo,
          ref: input.headSha,
          installationToken: input.installationToken,
        }),
      ),
    )
    const existing = Array.isArray(checks.check_runs)
      ? checks.check_runs
          .map(record)
          .find(
            (check) => text(check.external_id) === input.delivery.deliveryGuid && text(check.name) === "Synergy Review",
          )
      : undefined
    checkRunUrl = responseUrl(existing)
    if (!checkRunUrl) {
      const created = await GitHubAppAuth.GitHubClient.send<unknown>(
        GitHubAppAuth.GitHubClient.createCheckRun({
          owner: input.owner,
          repo: input.repo,
          name: "Synergy Review",
          headSha: input.headSha,
          externalId: input.delivery.deliveryGuid,
          conclusion: failed ? "failure" : "success",
          output: {
            title: failed ? "Synergy found actionable issues" : "Synergy review passed",
            summary: input.output.summary,
            text: body,
          },
          installationToken: input.installationToken,
        }),
      )
      checkRunUrl = responseUrl(created)
    }
    await recordReceipt(input.delivery.deliveryGuid, `check:${input.headSha}`, checkRunUrl)
  }
  return { reviewUrl, checkRunUrl }
}

export namespace GitHubWorkflowOrchestrator {
  export const gitEnvironment = buildGitEnvironment
  export async function ensureProjectScope(directory: string): Promise<Scope.Project> {
    const resolved = await Scope.fromDirectory(directory)
    if (resolved.scope.type !== "project" || resolved.scope.vcs !== "git") {
      throw new Error(`GitHub workflow repository mapping is not a git project: ${directory}`)
    }
    return resolved.scope
  }

  export async function fetchRevision(input: { directory: string; token: string; repoUrl: string; revision: string }) {
    if (!input.revision.trim()) throw new Error("Git revision is required")
    const credential = GitHubAppAuth.buildCredentialCommand({
      token: input.token,
      args: ["fetch", "--no-tags", "--no-write-fetch-head", input.repoUrl, input.revision],
    })
    await runGit({ cwd: input.directory, args: credential.args, env: credential.env })
  }

  export async function pushBranch(input: { directory: string; token: string; repoUrl: string; branchName: string }) {
    if (!input.branchName.trim()) throw new Error("Git branch name is required")
    const credential = GitHubAppAuth.buildCredentialCommand({
      token: input.token,
      args: ["push", input.repoUrl, `HEAD:refs/heads/${input.branchName}`],
    })
    await runGit({ cwd: input.directory, args: credential.args, env: credential.env })
  }

  export async function processFixDelivery(delivery: GitHubDelivery, inputConfig: IntegrationConfig) {
    const config = GitHubIntegrationConfig.parse(inputConfig)
    const mapping = config.fixWorkflow.repositoryMapping[delivery.repositoryFullName]
    if (!mapping) throw new Error(`Repository ${delivery.repositoryFullName} is unmapped for the GitHub fix workflow`)
    const observation = delivery.observation ?? projectGitHubDelivery(delivery)
    const payload = record(delivery.rawPayload)
    const issue = record(payload.issue)
    const issueNumber = observation.issueNumber ?? number(issue.number)
    const installationId =
      observation.installationId ?? delivery.installationId ?? number(record(payload.installation).id)
    if (!issueNumber) throw new Error("GitHub issue number is missing")
    if (!installationId) throw new Error("GitHub App installation ID is missing")

    const scope = await ensureProjectScope(mapping)
    const anchor = await ensureWorkflowAnchor(scope, delivery.repositoryFullName, "fix")
    const { owner, repo } = splitRepository(delivery.repositoryFullName)
    const installationToken = await GitHubAppAuth.getInstallationToken(installationId)
    const repoUrl = `https://github.com/${owner}/${repo}.git`
    const repository = await GitHubAppAuth.GitHubClient.send<unknown>(
      GitHubAppAuth.GitHubClient.getRepository({ owner, repo, installationToken }),
    )
    const defaultBranch = observation.defaultBranch ?? text(record(repository).default_branch)
    if (!defaultBranch) throw new Error("GitHub repository default branch is missing")
    const branch = await GitHubAppAuth.GitHubClient.send<unknown>(
      GitHubAppAuth.GitHubClient.getBranch({ owner, repo, branch: defaultBranch, installationToken }),
    )
    const baseRevision = text(record(record(branch).commit).sha)
    if (!baseRevision) throw new Error(`GitHub default branch ${defaultBranch} has no commit SHA`)
    await fetchRevision({ directory: scope.directory, token: installationToken, repoUrl, revision: baseRevision })

    let diagnosis = delivery.fixOutput
    if (!diagnosis) {
      const located = await GitHubWorkflowLocator.locateIssue({
        scope,
        ...anchor,
        deliveryGuid: delivery.deliveryGuid,
        observation,
        baseRevision,
        agent: config.fixWorkflow.locatorAgent,
        timeoutMs: config.fixWorkflow.timeoutMs,
        onTaskStarted: async (task) => {
          await updateDelivery(delivery.deliveryGuid, (draft) => {
            draft.locatorTaskId = task.id
          })
        },
      })
      diagnosis = located.output
      await updateDelivery(delivery.deliveryGuid, (draft) => {
        draft.fixOutput = diagnosis
      })
    }

    const proposedCommentUrl = await ensureIssueComment({
      delivery,
      owner,
      repo,
      issueNumber,
      key: "comment:fix_proposed",
      marker: issueMarker(delivery.deliveryGuid, "proposed"),
      body: renderProposedFix(diagnosis),
      installationToken,
    })
    await updateDelivery(delivery.deliveryGuid, (draft) => {
      draft.issueCommentUrl = proposedCommentUrl
    })

    const fixed = await launchFixTask({
      scope,
      anchor,
      delivery,
      observation,
      diagnosis,
      baseRevision,
      agent: config.fixWorkflow.agent,
      timeoutMs: config.fixWorkflow.timeoutMs,
    })
    const worktree = await ScopeRuntime.provide({ scope, fn: () => Worktree.status(fixed.task.sessionID) })
    if (worktree.workspace?.type !== "git_worktree") throw new Error("GitHub fix task has no worktree")
    const actualCommit = (await runGit({ cwd: worktree.path, args: ["rev-parse", "HEAD"] })).stdout
    if (actualCommit !== fixed.output.commitSha) {
      throw new Error(`GitHub fix task commit mismatch: reported ${fixed.output.commitSha}, actual ${actualCommit}`)
    }
    const branchName = GitHubAppAuth.buildFixBranchName({
      prefix: config.fixWorkflow.pushBranchPrefix,
      issueNumber,
      slug: observation.title ?? `issue-${issueNumber}`,
    })
    await pushBranch({ directory: worktree.path, token: installationToken, repoUrl, branchName })
    await recordReceipt(delivery.deliveryGuid, `branch:${branchName}`, `refs/heads/${branchName}`)

    const pullRequestUrl = await ensurePullRequest({
      delivery,
      owner,
      repo,
      issueNumber,
      branchName,
      base: defaultBranch,
      title: `Fix: ${observation.title ?? `issue #${issueNumber}`}`,
      body: renderFixPullRequest({ issueNumber, diagnosis, execution: fixed.output }),
      installationToken,
    })
    if (!pullRequestUrl) throw new Error("GitHub pull request response did not include a URL")
    const completionCommentUrl = await ensureIssueComment({
      delivery,
      owner,
      repo,
      issueNumber,
      key: "comment:fix_completed",
      marker: issueMarker(delivery.deliveryGuid, "completed"),
      body: `Implemented and verified the proposed fix in ${pullRequestUrl}.`,
      installationToken,
    })

    await updateDelivery(delivery.deliveryGuid, (draft) => {
      draft.fixExecution = fixed.output
      draft.branchName = branchName
      draft.pullRequestUrl = pullRequestUrl
      draft.completionCommentUrl = completionCommentUrl
      draft.status = "completed"
      draft.statusMetadata = { ...(draft.statusMetadata ?? {}), processing: "completed" }
    })
    if (worktree.worktree?.id) {
      await ScopeRuntime.provide({
        scope,
        fn: () => Worktree.remove({ sessionID: fixed.task.sessionID, target: worktree.worktree!.id, force: false }),
      }).catch(() => undefined)
    }
  }

  export async function processReviewDelivery(delivery: GitHubDelivery, inputConfig: IntegrationConfig) {
    if (!shouldProcessReviewDelivery(delivery, inputConfig)) return
    const payload = record(delivery.rawPayload)
    const config = GitHubIntegrationConfig.parse(inputConfig)
    const mapping = config.reviewWorkflow.repositoryMapping[delivery.repositoryFullName]
    if (!mapping)
      throw new Error(`Repository ${delivery.repositoryFullName} is unmapped for the GitHub review workflow`)
    const observation = delivery.observation ?? projectGitHubDelivery(delivery)
    const pull = record(payload.pull_request)
    const pullNumber = observation.pullRequestNumber ?? number(pull.number)
    const installationId =
      observation.installationId ?? delivery.installationId ?? number(record(payload.installation).id)
    if (!pullNumber) throw new Error("GitHub pull request number is missing")
    if (!installationId) throw new Error("GitHub App installation ID is missing")

    const scope = await ensureProjectScope(mapping)
    const anchor = await ensureWorkflowAnchor(scope, delivery.repositoryFullName, "review")
    const { owner, repo } = splitRepository(delivery.repositoryFullName)
    const installationToken = await GitHubAppAuth.getInstallationToken(installationId)
    const repoUrl = `https://github.com/${owner}/${repo}.git`
    const pullRequest = record(
      await GitHubAppAuth.GitHubClient.send<unknown>(
        GitHubAppAuth.GitHubClient.getPullRequest({ owner, repo, pullNumber, installationToken }),
      ),
    )
    const headSha = text(record(pullRequest.head).sha)
    const baseSha = text(record(pullRequest.base).sha)
    if (!headSha || !baseSha) throw new Error("GitHub pull request head or base SHA is missing")
    if (observation.headSha && observation.headSha !== headSha) {
      throw new Error(`GitHub pull request head changed from ${observation.headSha} to ${headSha}`)
    }
    await Promise.all([
      fetchRevision({ directory: scope.directory, token: installationToken, repoUrl, revision: headSha }),
      fetchRevision({ directory: scope.directory, token: installationToken, repoUrl, revision: baseSha }),
    ])

    const reviewed = await launchReviewTask({
      scope,
      anchor,
      delivery,
      observation: { ...observation, headSha },
      headSha,
      baseSha,
      config: config.reviewWorkflow,
    })
    const publication = await ensureReviewPublication({
      delivery,
      output: reviewed.output,
      owner,
      repo,
      pullNumber,
      headSha,
      installationToken,
      config: config.reviewWorkflow,
    })
    await updateDelivery(delivery.deliveryGuid, (draft) => {
      draft.reviewOutput = reviewed.output
      draft.reviewUrl = publication.reviewUrl
      draft.checkRunUrl = publication.checkRunUrl
      draft.status = "completed"
      draft.statusMetadata = { ...(draft.statusMetadata ?? {}), processing: "completed" }
    })
  }

  export function receipt(delivery: GitHubDelivery, key: string) {
    return existingReceipt(delivery, key)
  }

  export function shouldProcessReviewDelivery(delivery: GitHubDelivery, inputConfig: IntegrationConfig) {
    if (delivery.eventType !== "pull_request") return false
    const action = text(record(delivery.rawPayload).action)
    if (!action || action === "closed") return false
    const config = GitHubIntegrationConfig.parse(inputConfig)
    return config.reviewWorkflow.enabled && config.reviewWorkflow.eventTypes.includes(`pull_request.${action}`)
  }
}
