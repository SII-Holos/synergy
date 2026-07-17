import z from "zod"

export const GitHubModelBudget = z
  .object({
    maxTokens: z.number().int().positive(),
    maxCost: z.number().nonnegative(),
  })
  .strict()
export type GitHubModelBudget = z.infer<typeof GitHubModelBudget>

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
  })
  .strict()
  .meta({ ref: "GitHubIntegrationConfig" })
export type GitHubIntegrationConfig = z.infer<typeof GitHubIntegrationConfig>

export const GitHubDecision = z.enum([
  "ignored_bot",
  "ignored_type",
  "gated_issue",
  "gated_ci",
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

export const GitHubDeliveryStatus = z.enum([
  "received",
  "processing",
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
