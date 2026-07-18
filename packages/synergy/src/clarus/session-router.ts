import { Session } from "@/session"
import { SessionEndpoint } from "@/session/endpoint"
import { SessionManager } from "@/session/manager"
import { SessionInbox } from "@/session/inbox"
import { SessionInteraction } from "@/session/interaction"
import { Identifier } from "@/id/id"
import { ScopeContext } from "@/scope/context"
import { Lock } from "@/util/lock"
import { ClarusWorkspace } from "./workspace"
import { ClarusBindingStore, ClarusTaskBindingStore } from "./binding"
import { ClarusDedup } from "./dedup"
import { ClarusProjectActivityStore } from "./activity"
import { ClarusFanoutProgressStore } from "./activity"
import { lockKey, validateSegment, deriveAssignmentIDs } from "./keys"
import type { ClarusDelivery, ClarusTaskBindingV4 } from "./schemas"
import { Scope } from "@/scope"
type SessionInfo = Session.Info

function taskMail(input: {
  sessionID: string
  messageID: string
  text: string
  agent?: string
  tools?: Record<string, boolean>
  extraMetadata?: Record<string, unknown>
}): SessionManager.SessionMail.User {
  return {
    type: "user",
    parts: [
      {
        id: Identifier.ascending("part"),
        sessionID: input.sessionID,
        messageID: input.messageID,
        type: "text",
        text: input.text,
      },
    ],
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    metadata: { source: "clarus", ...(input.extraMetadata ?? {}) },
  }
}

export async function getOrCreateTaskSession(input: {
  agentId: string
  projectId: string
  taskId: string
  scope?: Scope
}): Promise<SessionInfo> {
  validateSegment(input.agentId)
  validateSegment(input.projectId)
  validateSegment(input.taskId)

  const existing = await getTaskSession(input)
  if (existing) return existing

  const sessionLock = lockKey("session", input.agentId, input.projectId, input.taskId)
  using _lr = await Lock.write(sessionLock)

  const recheck = await getTaskSessionLocked(input)
  if (recheck) return recheck

  const homeScope = Scope.home()

  // Crash recovery: if we have an unresolved ownership claim, try to recover
  const recoverable = await ClarusTaskBindingStore.recoverOwnership({
    agentId: input.agentId,
    projectId: input.projectId,
    taskId: input.taskId,
    claimedByScopeID: homeScope.id,
  })
  if (recoverable) {
    const recoveredSession = await SessionManager.getSession(recoverable.sessionID)
    if (recoveredSession) {
      await ClarusTaskBindingStore.resolveOwnership({
        agentId: input.agentId,
        projectId: input.projectId,
        taskId: input.taskId,
      })
      return recoveredSession
    }
  }

  // Existing binding with discoverable session
  const existingTaskBinding = await ClarusTaskBindingStore.get(input.agentId, input.projectId, input.taskId)
  if (existingTaskBinding) {
    const taskSession = await SessionManager.getSession(existingTaskBinding.sessionID)
    if (taskSession) {
      if (existingTaskBinding.taskSessionOwnershipClaim && !existingTaskBinding.taskSessionOwnershipClaim.resolvedAt) {
        await ClarusTaskBindingStore.resolveOwnership({
          agentId: input.agentId,
          projectId: input.projectId,
          taskId: input.taskId,
        })
      }
      return taskSession
    }
  }

  const workspacePath = await ClarusWorkspace.ensureWorkspace(input)

  const workspace = {
    type: "clarus_project" as const,
    path: workspacePath,
    scopeID: homeScope.id,
  }

  const endpoint = SessionEndpoint.fromClarus({
    role: "task",
    agentId: input.agentId,
    projectId: input.projectId,
    taskId: input.taskId,
  })

  const session = await ScopeContext.provide({
    scope: homeScope,
    workspace,
    fn: () =>
      Session.create({
        title: `Task — ${input.taskId}`,
        endpoint,
        workspace,
        controlProfile: "autonomous",
        interaction: SessionInteraction.unattended("clarus"),
      }),
  })

  await ClarusTaskBindingStore.ensureAssigned(
    input.agentId,
    input.projectId,
    input.taskId,
    session.id,
    workspacePath,
    homeScope.id,
  )

  await ClarusTaskBindingStore.acquireOwnership({
    agentId: input.agentId,
    projectId: input.projectId,
    taskId: input.taskId,
    claimedByScopeID: homeScope.id,
  })

  await ClarusTaskBindingStore.resolveOwnership({
    agentId: input.agentId,
    projectId: input.projectId,
    taskId: input.taskId,
  })

  return session
}

async function getTaskSessionLocked(input: {
  agentId: string
  projectId: string
  taskId: string
}): Promise<SessionInfo | undefined> {
  const endpoint = SessionEndpoint.fromClarus({
    role: "task",
    agentId: input.agentId,
    projectId: input.projectId,
    taskId: input.taskId,
  })
  return SessionManager.getSession(endpoint)
}

export async function getTaskSession(input: {
  agentId: string
  projectId: string
  taskId: string
}): Promise<SessionInfo | undefined> {
  return getTaskSessionLocked(input)
}
export async function deliverProjectMessage(input: {
  agentId: string
  projectId: string
  messageId: string
  senderId?: string
  text: string
  receivedAt?: number
}): Promise<ClarusDelivery> {
  validateSegment(input.agentId)
  validateSegment(input.projectId)
  validateSegment(input.messageId)

  const bindingLock = lockKey("binding", input.agentId, input.projectId)
  const dedupOrBindings = await (async () => {
    using _gate = await Lock.write(bindingLock)

    const active = await ClarusBindingStore.isActive(input.agentId, input.projectId)
    if (!active) {
      throw new Error(`Clarus project is inactive: agentId=${input.agentId}, projectId=${input.projectId}`)
    }

    const dedup = await ClarusDedup.getMessage(input.agentId, input.projectId, input.messageId)
    if (dedup) return { kind: "dedup" as const, dedup }

    await ClarusProjectActivityStore.upsert({
      agentId: input.agentId,
      projectId: input.projectId,
      messageId: input.messageId,
      senderId: input.senderId,
      content: input.text,
      receivedAt: input.receivedAt ?? Date.now(),
    })

    const bindings = await ClarusTaskBindingStore.listTaskBindings(input.agentId, input.projectId)
    return { kind: "bindings" as const, bindings }
  })()

  // Dedup hit inside lock — activity_only means no bindings existed, return early
  if (dedupOrBindings.kind === "dedup") {
    if (dedupOrBindings.dedup.outcome === "activity_only") return dedupOrBindings.dedup
    // injected dedup: fall through to per-target progress check for missing targets
    const existingDedup = dedupOrBindings.dedup
    const bindings = await ClarusTaskBindingStore.listTaskBindings(input.agentId, input.projectId)
    return projectFanoutWithProgress(input, bindings, existingDedup)
  }

  return projectFanoutNew(input, dedupOrBindings.bindings)
}

const FANOUT_CONCURRENCY = 8

/** First-time project message fanout: delivers to all non-terminal task bindings
 *  and records per-target progress + project dedup. Checks per-target progress
 *  to skip targets already delivered in a prior run that crashed before dedup. */
async function projectFanoutNew(
  input: { agentId: string; projectId: string; messageId: string; text: string },
  bindings: ClarusTaskBindingV4[],
): Promise<ClarusDelivery> {
  const activeBindings = bindings.filter(
    (b) => b.status !== "cancelled" && b.status !== "failed" && b.status !== "expired" && b.status !== "submitted",
  )
  if (activeBindings.length === 0) {
    await ClarusDedup.recordMessage(input.agentId, input.projectId, input.messageId, { outcome: "activity_only" })
    return { outcome: "activity_only" }
  }

  let primarySessionID = ""
  let primaryInboxItemID = ""

  const targets = deriveProjectTargets(input, activeBindings)

  // Primary: always use the first binding to ensure a valid dedup entry
  // even when all targets were already delivered (crash recovery).
  if (targets.length > 0) {
    primarySessionID = targets[0].binding.sessionID
    primaryInboxItemID = targets[0].itemID
  }

  // Filter to only targets without existing per-target progress.
  // This handles crash-after-delivery-before-dedup: targets delivered
  // in the prior run have retained their progress records.
  const pendingTargets: typeof targets = []
  for (const t of targets) {
    const delivered = await ClarusFanoutProgressStore.isDelivered(
      input.agentId,
      input.projectId,
      input.messageId,
      t.binding.sessionID,
    )
    if (!delivered) pendingTargets.push(t)
  }

  for (let i = 0; i < pendingTargets.length; i += FANOUT_CONCURRENCY) {
    const batch = pendingTargets.slice(i, i + FANOUT_CONCURRENCY)
    await Promise.all(
      batch.map(async (t) => {
        await SessionManager.deliverContext({
          target: t.binding.sessionID,
          inboxItemID: t.itemID,
          inboxMessageID: t.messageID,
          parts: [{ id: Identifier.ascending("part"), type: "text" as const, text: input.text }],
          source: { type: "clarus", label: "Clarus Activity" },
        })
        await ClarusFanoutProgressStore.recordDelivery(
          input.agentId,
          input.projectId,
          input.messageId,
          t.binding.sessionID,
        )
      }),
    )
  }

  const entry = { outcome: "injected" as const, sessionID: primarySessionID, inboxItemID: primaryInboxItemID }
  await ClarusDedup.recordMessage(input.agentId, input.projectId, input.messageId, entry)

  // Cleanup per-target progress now that dedup is durably recorded.
  // Deterministic inbox item IDs remain the replay/collision guard
  // for any retry that reaches this message again.
  await ClarusFanoutProgressStore.deleteAllDeliveriesByMessage(input.agentId, input.projectId, input.messageId)

  return entry
}

/** Retry project message fanout: skips targets with per-target progress,
 *  only delivers to missing targets. Returns existing dedup entry unchanged. */
async function projectFanoutWithProgress(
  input: { agentId: string; projectId: string; messageId: string; text: string },
  bindings: ClarusTaskBindingV4[],
  existingDedup: ClarusDelivery,
): Promise<ClarusDelivery> {
  const activeBindings = bindings.filter(
    (b) => b.status !== "cancelled" && b.status !== "failed" && b.status !== "expired" && b.status !== "submitted",
  )
  if (activeBindings.length === 0) return existingDedup

  const targets = deriveProjectTargets(input, activeBindings)

  // Filter to only targets that haven't been delivered yet
  const pendingTargets: typeof targets = []
  for (const t of targets) {
    const delivered = await ClarusFanoutProgressStore.isDelivered(
      input.agentId,
      input.projectId,
      input.messageId,
      t.binding.sessionID,
    )
    if (!delivered) pendingTargets.push(t)
  }

  for (let i = 0; i < pendingTargets.length; i += FANOUT_CONCURRENCY) {
    const batch = pendingTargets.slice(i, i + FANOUT_CONCURRENCY)
    await Promise.all(
      batch.map(async (t) => {
        try {
          await SessionManager.deliverContext({
            target: t.binding.sessionID,
            inboxItemID: t.itemID,
            inboxMessageID: t.messageID,
            parts: [{ id: Identifier.ascending("part"), type: "text" as const, text: input.text }],
            source: { type: "clarus", label: "Clarus Activity" },
          })
        } catch (err) {
          // Deterministic inbox item ID collision means the target already
          // received this context in a prior run whose progress was cleaned up.
          // The existing inbox item is durable proof of delivery — skip.
          if (err instanceof Error && "code" in err && (err as { code: string }).code === "CLARUS_INBOX_COLLISION")
            return
          throw err
        }
        await ClarusFanoutProgressStore.recordDelivery(
          input.agentId,
          input.projectId,
          input.messageId,
          t.binding.sessionID,
        )
      }),
    )
  }

  // Cleanup per-target progress now that all active targets have been
  // delivered (or already had progress). Deterministic inbox item IDs
  // remain the replay/collision guard for any retry.
  await ClarusFanoutProgressStore.deleteAllDeliveriesByMessage(input.agentId, input.projectId, input.messageId)

  return existingDedup
}

/** Derive deterministic per-target inbox/message IDs for project fanout. */
function deriveProjectTargets(
  input: { agentId: string; projectId: string; messageId: string },
  bindings: { sessionID: string }[],
) {
  return bindings.map((binding) => {
    const hashInput = `${encodeURIComponent(input.agentId)}:${encodeURIComponent(input.projectId)}:${encodeURIComponent(input.messageId)}:${binding.sessionID}`
    const hash = new Bun.CryptoHasher("sha256").update(hashInput).digest("base64url").slice(0, 32)
    return {
      binding,
      itemID: `inb_clarus_ctx_${hash}`,
      messageID: `msg_clarus_ctx_${hash}`,
    }
  })
}
export async function deliverTaskMessage(input: {
  agentId: string
  projectId: string
  taskId: string
  messageId: string
  text: string
  tools?: Record<string, boolean>
  extraMetadata?: Record<string, unknown>
}): Promise<ClarusDelivery> {
  validateSegment(input.agentId)
  validateSegment(input.projectId)
  validateSegment(input.taskId)
  validateSegment(input.messageId)

  const bindingLock = lockKey("binding", input.agentId, input.projectId)
  using _gate = await Lock.write(bindingLock)

  const active = await ClarusBindingStore.isActive(input.agentId, input.projectId)
  if (!active) {
    throw new Error(`Clarus project is inactive: agentId=${input.agentId}, projectId=${input.projectId}`)
  }

  const { itemID, messageID: deterministicMessageID } = deriveAssignmentIDs(
    input.agentId,
    input.projectId,
    input.taskId,
  )

  const existingBinding = await ClarusTaskBindingStore.get(input.agentId, input.projectId, input.taskId)

  if (existingBinding?.assignmentInboxItemID) {
    if (existingBinding.assignmentState === "planned") {
      await recoverPlannedDelivery(input, existingBinding, itemID, deterministicMessageID)
    }
    return {
      outcome: "injected" as const,
      sessionID: existingBinding.sessionID,
      inboxItemID: existingBinding.assignmentInboxItemID,
    }
  }

  const dedup = await ClarusDedup.getTaskMessage(input.agentId, input.projectId, input.taskId, input.messageId)
  if (dedup) return dedup

  const taskSession = await getOrCreateTaskSession(input)
  const taskBinding = await ClarusTaskBindingStore.get(input.agentId, input.projectId, input.taskId)

  const legacyDelivery = await recoverLegacyPartialState(input, taskSession.id, itemID, deterministicMessageID)
  if (legacyDelivery) return legacyDelivery

  await ClarusTaskBindingStore.planAssignment(
    input.agentId,
    input.projectId,
    input.taskId,
    itemID,
    deterministicMessageID,
  )

  const deliveryResult = await SessionManager.deliverWithResult({
    target: taskSession.id,
    mail: taskMail({
      sessionID: taskSession.id,
      messageID: deterministicMessageID,
      text: input.text,
      agent: taskBinding?.frozenAgent,
      extraMetadata: input.extraMetadata,
      tools: input.tools,
    }),
    inboxItemID: itemID,
    inboxMessageID: deterministicMessageID,
  })

  await ClarusTaskBindingStore.markEnqueued(input.agentId, input.projectId, input.taskId)

  const dedupEntry = {
    outcome: "injected" as const,
    sessionID: deliveryResult.sessionID,
    inboxItemID: deliveryResult.itemID,
  }
  await ClarusDedup.recordTaskMessage(input.agentId, input.projectId, input.taskId, input.messageId, dedupEntry)

  return dedupEntry
}

async function recoverPlannedDelivery(
  input: {
    agentId: string
    projectId: string
    taskId: string
    messageId: string
    text: string
    tools?: Record<string, boolean>
  },
  binding: { sessionID: string; assignmentInboxItemID?: string; assignmentMessageID?: string; frozenAgent?: string },
  itemID: string,
  deterministicMessageID: string,
): Promise<void> {
  const resolvedItemID = binding.assignmentInboxItemID ?? itemID
  const resolvedMessageID = binding.assignmentMessageID ?? deterministicMessageID

  try {
    await SessionInbox.getStored(binding.sessionID, resolvedItemID)
    await ClarusTaskBindingStore.markEnqueued(input.agentId, input.projectId, input.taskId)
  } catch {
    await SessionManager.deliverWithResult({
      target: binding.sessionID,
      mail: taskMail({
        sessionID: binding.sessionID,
        messageID: resolvedMessageID,
        text: input.text,
        agent: binding.frozenAgent,
        tools: input.tools,
      }),
      inboxItemID: resolvedItemID,
      inboxMessageID: resolvedMessageID,
    })
    await ClarusTaskBindingStore.markEnqueued(input.agentId, input.projectId, input.taskId)
  }
}

async function recoverLegacyPartialState(
  input: { agentId: string; projectId: string; taskId: string; messageId: string; text: string },
  sessionID: string,
  itemID: string,
  deterministicMessageID: string,
): Promise<ClarusDelivery | null> {
  try {
    await SessionInbox.getStored(sessionID, itemID)
    const workspacePath = await ClarusWorkspace.ensureWorkspace({ agentId: input.agentId, projectId: input.projectId })
    const scope = ScopeContext.current.scope
    await ClarusTaskBindingStore.ensureAssigned(
      input.agentId,
      input.projectId,
      input.taskId,
      sessionID,
      workspacePath,
      scope.id,
    )
    await ClarusTaskBindingStore.planAssignment(
      input.agentId,
      input.projectId,
      input.taskId,
      itemID,
      deterministicMessageID,
    )
    await ClarusTaskBindingStore.markEnqueued(input.agentId, input.projectId, input.taskId)
    return { outcome: "injected" as const, sessionID, inboxItemID: itemID }
  } catch {
    // Not found — continue to check transcript
  }

  const messages = await Session.messages({ sessionID })
  const hasDeterministicMessage = messages.some((m) => m.info.id === deterministicMessageID)
  if (hasDeterministicMessage) {
    const workspacePath = await ClarusWorkspace.ensureWorkspace({ agentId: input.agentId, projectId: input.projectId })
    const scope = ScopeContext.current.scope
    await ClarusTaskBindingStore.ensureAssigned(
      input.agentId,
      input.projectId,
      input.taskId,
      sessionID,
      workspacePath,
      scope.id,
    )
    await ClarusTaskBindingStore.planAssignment(
      input.agentId,
      input.projectId,
      input.taskId,
      itemID,
      deterministicMessageID,
    )
    await ClarusTaskBindingStore.markEnqueued(input.agentId, input.projectId, input.taskId)
    return { outcome: "injected" as const, sessionID, inboxItemID: itemID }
  }

  return null
}
