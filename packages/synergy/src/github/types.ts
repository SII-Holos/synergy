import z from "zod"

export const GitHubModelBudget = z
  .object({
    maxTokens: z.number().int().positive(),
    maxCost: z.number().nonnegative(),
  })
  .strict()
export type GitHubModelBudget = z.infer<typeof GitHubModelBudget>

const RepositoryMapping = z.record(z.string().min(1), z.string().min(1))

export type GitHubWorkflowAnchor = {
  parentSessionID: string
  parentMessageID: string
}
export const GitHubFixWorkflowConfig = z
  .object({
    enabled: z.boolean().default(false),
    repositoryMapping: RepositoryMapping.default({}),
    maxRetries: z.number().int().min(0).max(20).default(3),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1_000),
    locatorAgent: z.string().min(1).default("github-issue-locator"),
    agent: z.string().min(1).default("github-fix-coder"),
    pushBranchPrefix: z.string().min(1).default("synergy/fix/"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && Object.keys(value.repositoryMapping).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["repositoryMapping"],
        message: "repositoryMapping is required when the GitHub fix workflow is enabled",
      })
    }
  })
  .default({
    enabled: false,
    repositoryMapping: {},
    maxRetries: 3,
    timeoutMs: 15 * 60 * 1_000,
    locatorAgent: "github-issue-locator",
    agent: "github-fix-coder",
    pushBranchPrefix: "synergy/fix/",
  })
export type GitHubFixWorkflowConfig = z.infer<typeof GitHubFixWorkflowConfig>

export const GitHubReviewWorkflowConfig = z
  .object({
    enabled: z.boolean().default(false),
    repositoryMapping: RepositoryMapping.default({}),
    eventTypes: z
      .array(z.string().min(1))
      .default(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"]),
    reviewCommands: z.array(z.string().min(1)).default(["bun test", "bun run typecheck"]),
    maxRetries: z.number().int().min(0).max(20).default(3),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1_000),
    agent: z.string().min(1).default("github-review-agent"),
    publishReviewComment: z.boolean().default(true),
    publishCheckRun: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && Object.keys(value.repositoryMapping).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["repositoryMapping"],
        message: "repositoryMapping is required when the GitHub review workflow is enabled",
      })
    }
  })
  .default({
    enabled: false,
    repositoryMapping: {},
    eventTypes: ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
    reviewCommands: ["bun test", "bun run typecheck"],
    maxRetries: 3,
    timeoutMs: 15 * 60 * 1_000,
    agent: "github-review-agent",
    publishReviewComment: true,
    publishCheckRun: true,
  })
export type GitHubReviewWorkflowConfig = z.infer<typeof GitHubReviewWorkflowConfig>

export const GitHubIntegrationConfig = z
  .object({
    enabled: z.boolean().default(false),
    watchedRepositories: z.array(z.string().min(1)).optional(),
    eventTypes: z.array(z.string().min(1)).default(["issues.opened", "workflow_run.completed"]),
    ciFailureThreshold: z.number().int().positive().default(3),
    ciFailureWindowHours: z.number().int().positive().default(24),
    modelBudgetNano: GitHubModelBudget.default({ maxTokens: 256, maxCost: 0.001 }),
    modelBudgetProposal: GitHubModelBudget.default({ maxTokens: 2048, maxCost: 0.02 }),
    classifierEnabled: z.boolean().default(false),
    proposalEnabled: z.boolean().default(false),
    fixWorkflow: GitHubFixWorkflowConfig,
    reviewWorkflow: GitHubReviewWorkflowConfig,
  })
  .strict()
  .meta({ ref: "GitHubIntegrationConfig" })
export type GitHubIntegrationConfig = z.infer<typeof GitHubIntegrationConfig>

export const GitHubDecision = z.enum([
  "ignored_bot",
  "ignored_type",
  "gated_issue",
  "gated_ci",
  "gated_pr",
  "ambiguous_issue",
  "try_classify",
])
export type GitHubDecision = z.infer<typeof GitHubDecision>

export const GitHubTriggerDecision = z
  .object({
    deliveryGuid: z.string().min(1),
    eventType: z.string().min(1),
    decision: GitHubDecision,
    reason: z.string().min(1),
    classifierNeeded: z.boolean().default(false),
    proposalTriggered: z.boolean().default(false),
    fixTriggered: z.boolean().default(false),
    reviewTriggered: z.boolean().default(false),
  })
  .strict()
export type GitHubTriggerDecision = z.infer<typeof GitHubTriggerDecision>

export const GitHubObservation = z
  .object({
    eventType: z.string(),
    action: z.string().optional(),
    repository: z.string(),
    sender: z.string().optional(),
    title: z.string().max(500).optional(),
    body: z.string().max(8_000).optional(),
    url: z.string().optional(),
    issueNumber: z.number().int().positive().optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    headSha: z.string().min(1).optional(),
    headRef: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).optional(),
    installationId: z.number().int().positive().optional(),
    workflowName: z.string().max(500).optional(),
    conclusion: z.string().optional(),
  })
  .strict()
export type GitHubObservation = z.infer<typeof GitHubObservation>

export const GitHubClassification = z
  .object({
    relevant: z.boolean(),
    category: z.enum(["bug", "feature", "question"]),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
  })
  .strict()
export type GitHubClassification = z.infer<typeof GitHubClassification>

export const GitHubActionProposal = z
  .object({
    deliveryGuid: z.string().min(1),
    triggerEventType: z.string().min(1),
    proposalType: z.enum(["issue_triage", "ci_failure_diagnosis", "none"]),
    summary: z.string().min(1).max(500),
    rationale: z.string().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    suggestedActions: z.array(z.string().min(1).max(500)).max(10),
  })
  .strict()
  .meta({ ref: "GitHubActionProposal" })
export type GitHubActionProposal = z.infer<typeof GitHubActionProposal>

export const GitHubFixOutput = z
  .object({
    rootCause: z.string().min(1).max(4_000),
    affectedFiles: z.array(z.string().min(1).max(1_000)).max(50),
    plannedChanges: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .meta({ ref: "GitHubFixOutput" })
export type GitHubFixOutput = z.infer<typeof GitHubFixOutput>

export const GitHubFixExecutionOutput = z
  .object({
    summary: z.string().min(1).max(4_000),
    changedFiles: z.array(z.string().min(1).max(1_000)).max(100),
    testResults: z.array(
      z.object({
        command: z.string().min(1),
        passed: z.boolean(),
        output: z.string().max(8_000),
      }),
    ),
    commitSha: z.string().min(1),
  })
  .strict()
  .meta({ ref: "GitHubFixExecutionOutput" })
export type GitHubFixExecutionOutput = z.infer<typeof GitHubFixExecutionOutput>

export const GitHubReviewDefect = z
  .object({
    severity: z.enum(["critical", "high", "medium", "low"]),
    file: z.string().min(1).max(1_000),
    line: z.number().int().positive().optional(),
    message: z.string().min(1).max(4_000),
  })
  .strict()

export const GitHubReviewOutput = z
  .object({
    defects: z.array(GitHubReviewDefect).max(100),
    testResults: z.array(
      z.object({
        command: z.string().min(1),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        output: z.string().max(8_000),
      }),
    ),
    summary: z.string().min(1).max(8_000),
  })
  .strict()
  .meta({ ref: "GitHubReviewOutput" })
export type GitHubReviewOutput = z.infer<typeof GitHubReviewOutput>

export const GitHubDeliveryStatus = z.enum([
  "received",
  "processing",
  "processing_fix",
  "processing_review",
  "completed",
  "ignored",
  "permanent_failure",
  "retryable_failure",
])
export type GitHubDeliveryStatus = z.infer<typeof GitHubDeliveryStatus>

export const GitHubDelivery = z
  .object({
    deliveryGuid: z.string().min(1),
    eventType: z.string().min(1),
    installationId: z.number().int().positive().optional(),
    repositoryFullName: z.string(),
    senderLogin: z.string(),
    receivedAt: z.number(),
    rawPayload: z.unknown(),
    rawHeaders: z.record(z.string(), z.string()),
    status: GitHubDeliveryStatus,
    statusMetadata: z.record(z.string(), z.string()).optional(),
    triggerDecision: GitHubDecision.optional(),
    observation: GitHubObservation.optional(),
    classification: GitHubClassification.optional(),
    proposalTaskId: z.string().optional(),
    proposal: GitHubActionProposal.optional(),
    locatorTaskId: z.string().optional(),
    fixTaskId: z.string().optional(),
    fixOutput: GitHubFixOutput.optional(),
    fixExecution: GitHubFixExecutionOutput.optional(),
    reviewTaskId: z.string().optional(),
    reviewOutput: GitHubReviewOutput.optional(),
    issueCommentUrl: z.string().url().optional(),
    completionCommentUrl: z.string().url().optional(),
    branchName: z.string().optional(),
    pullRequestUrl: z.string().url().optional(),
    reviewUrl: z.string().url().optional(),
    checkRunUrl: z.string().url().optional(),
    retryCount: z.number().int().nonnegative().default(0),
  })
  .strict()
  .meta({ ref: "GitHubDelivery" })
export type GitHubDelivery = z.infer<typeof GitHubDelivery>

export const GitHubWebhookResponse = z
  .object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
  })
  .strict()
  .meta({ ref: "GitHubWebhookResponse" })
