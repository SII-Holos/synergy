import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { AsyncLocalStorage } from "node:async_hooks"
import {
  BrowserBackendCommandSchema,
  BrowserProtocolError,
  normalizeBrowserURL,
  type BrowserBackendCommand,
  type BrowserBackendResult,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserOwner } from "./owner.js"
import { BrowserPolicy } from "./policy.js"
import { BrowserRuntime, registerBrowserCommandExecutor } from "./runtime.js"
import type { BrowserSession } from "./types.js"
import { ObservabilityBrowserTelemetry } from "@ericsanchezok/synergy-harness/observability/browser-metrics"
import { BrowserProfiles } from "./profiles.js"

interface ExecuteRequest {
  pageId: string
  authorize?: (input: { profileId: string; url: string; command: BrowserBackendCommand }) => Promise<void>
  commandId: string
  command: BrowserBackendCommand
  signal?: AbortSignal
}

interface OwnerQueue {
  tail: Promise<void>
  dialogTail: Promise<void>
  pendingFingerprints: Map<string, string>
  resumeBinding?: ReturnType<typeof AsyncLocalStorage.snapshot>
  results: Map<string, { fingerprint: string; result?: BrowserBackendResult; error?: unknown; bytes: number }>
  resultBytes: number
  closing: boolean
}

const MAX_REPLAY_RESULTS = 256
const MAX_REPLAY_BYTES = 128 * 1024 * 1024
const runtimeState = RuntimeContext.state(() => ({
  queues: new Map<string, OwnerQueue>(),
  closingOwners: new Set<string>(),
  runtime: BrowserRuntime as Pick<typeof BrowserRuntime, "getOrCreateSession" | "withinOwner">,
}))

export namespace BrowserCommandService {
  export async function session(owner: BrowserOwner.Info): Promise<BrowserSession> {
    const instanceState = runtimeState()

    return instanceState.runtime.withinOwner(owner, (resolved) => instanceState.runtime.getOrCreateSession(resolved))
  }

  export async function execute(owner: BrowserOwner.Info, request: ExecuteRequest): Promise<BrowserBackendResult> {
    const key = queueKey(owner, request.pageId)
    const enter = () =>
      runtimeState().runtime.withinOwner(owner, (resolved) => executeQueued(resolved, request), request.signal)
    const resume = request.command.type === "dialog.respond" ? runtimeState().queues.get(key)?.resumeBinding : undefined
    return resume ? resume(enter) : enter()
  }

  async function executeQueued(owner: BrowserOwner.Info, request: ExecuteRequest): Promise<BrowserBackendResult> {
    const instanceState = runtimeState()

    BrowserOwner.assertValid(owner)
    if (!request.commandId.trim() || request.commandId.length > 20_000) {
      throw new BrowserProtocolError({
        code: "browser_command_id_required",
        message: "Browser commands require a non-empty commandId no longer than 20,000 characters.",
        retryable: false,
      })
    }
    const parsed = BrowserBackendCommandSchema.safeParse(request.command)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "command"}: ${issue.message}`)
        .join("; ")
      throw new BrowserProtocolError({
        code: "browser_invalid_command",
        message: `Browser command is invalid: ${detail}`,
        retryable: false,
        commandId: request.commandId,
        suggestedAction: "Use the current Browser tool schema and provide only fields valid for the selected action.",
      })
    }
    const command = parsed.data
    const session = await BrowserCommandService.session(owner)
    const descriptor = session.pages.find((page) => page.id === request.pageId)
    const profile =
      descriptor && command.type !== "close" ? await BrowserProfiles.requireEnabled(descriptor.profileId) : undefined
    const fingerprint = JSON.stringify({ command, revision: profile?.revision })
    const key = queueKey(owner, request.pageId)
    const queue = instanceState.queues.get(key) ?? createQueue()
    instanceState.queues.set(key, queue)
    if (queue.closing || instanceState.closingOwners.has(BrowserOwner.key(owner))) {
      throw new BrowserProtocolError({
        code: "browser_session_closing",
        message: "The Browser session is closing and cannot accept new commands.",
        retryable: true,
        commandId: request.commandId,
      })
    }
    const replay = queue.results.get(request.commandId)
    if (replay) {
      try {
        const result = replayResult(replay, fingerprint, request.commandId)

        return result
      } catch (error) {
        throw error
      }
    }

    const pendingFingerprint = queue.pendingFingerprints.get(request.commandId)
    if (pendingFingerprint !== undefined && pendingFingerprint !== fingerprint) {
      return replayResult({ fingerprint: pendingFingerprint }, fingerprint, request.commandId)
    }
    queue.pendingFingerprints.set(request.commandId, fingerprint)
    // Dialog responses must release the page command waiting on them, while
    // remaining serialized with each other for command replay and disposal.
    const repliesToDialog = command.type === "dialog.respond"
    const preceding = repliesToDialog ? queue.dialogTail : queue.tail
    const run = preceding.then(async () => {
      if (!repliesToDialog) queue.resumeBinding = AsyncLocalStorage.snapshot()
      throwIfAborted(request.signal, request.commandId)
      const repeated = queue.results.get(request.commandId)
      if (repeated) return replayResult(repeated, fingerprint, request.commandId)
      const span = ObservabilityBrowserTelemetry.startCommand(owner, command)
      ObservabilityBrowserTelemetry.recordCommand(owner, command)
      try {
        const result = await executeOnce(owner, command, request)
        ObservabilityBrowserTelemetry.recordSettle(owner, command, result)
        cache(queue, request.commandId, { fingerprint, result, bytes: encodedBytes(result) })
        ObservabilityBrowserTelemetry.endCommand(span, undefined, result)
        return result
      } catch (error) {
        const normalized = normalizeCommandError(error, request.commandId)
        cache(queue, request.commandId, { fingerprint, error: normalized, bytes: encodedBytes(normalized) })
        ObservabilityBrowserTelemetry.endCommand(span, normalized)
        recordCommandFailureTelemetry(owner, command, normalized)
        throw normalized
      }
    })
    const completed = repliesToDialog
      ? run
      : run.finally(() => {
          queue.resumeBinding = undefined
        })
    const settled = completed.then(
      (result) => {
        return result
      },
      (error) => {
        throw error
      },
    )
    const drained = settled
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => queue.pendingFingerprints.delete(request.commandId))
    if (repliesToDialog) {
      queue.dialogTail = drained
      queue.tail = Promise.all([queue.tail, drained]).then(() => undefined)
    } else queue.tail = drained
    return repliesToDialog ? settled : settled.finally(() => queue.dialogTail)
  }

  export function clear(): void {
    const instanceState = runtimeState()

    instanceState.closingOwners.clear()
    instanceState.queues.clear()
  }

  export async function disposeOwner(owner: BrowserOwner.Info, dispose: () => Promise<void>): Promise<void> {
    const instanceState = runtimeState()

    const ownerKey = BrowserOwner.key(owner)
    instanceState.closingOwners.add(ownerKey)
    const queues = [...instanceState.queues].filter(([key]) => key.startsWith(`${ownerKey}:`))
    try {
      await Promise.all(queues.map(([, queue]) => queue.tail))
      await dispose()
    } finally {
      for (const [key] of queues) instanceState.queues.delete(key)
      instanceState.closingOwners.delete(ownerKey)
    }
  }

  export function useRuntimeForTest(adapter: Pick<typeof BrowserRuntime, "getOrCreateSession">): () => void {
    const instanceState = runtimeState()

    const previous = instanceState.runtime
    instanceState.runtime = { ...adapter, withinOwner: (_owner, fn) => fn(_owner) }
    return () => {
      const instanceState = runtimeState()

      instanceState.runtime = previous
      clear()
    }
  }
}

function queueKey(owner: BrowserOwner.Info, pageId: string) {
  if (!pageId)
    throw new BrowserProtocolError({
      code: "browser_page_required",
      message: "Choose a pageId from browser_navigation list.",
      retryable: false,
    })
  return `${BrowserOwner.key(owner)}:${pageId}`
}

function createQueue(): OwnerQueue {
  return {
    tail: Promise.resolve(),
    dialogTail: Promise.resolve(),
    pendingFingerprints: new Map(),
    results: new Map(),
    resultBytes: 0,
    closing: false,
  }
}

function replayResult(
  replay: { fingerprint: string; result?: BrowserBackendResult; error?: unknown },
  fingerprint: string,
  commandId: string,
): BrowserBackendResult {
  if (replay.fingerprint !== fingerprint) {
    throw new BrowserProtocolError({
      code: "browser_command_id_conflict",
      message: "Browser commandId was already used for a different command.",
      retryable: false,
      commandId,
    })
  }
  if (replay.error !== undefined) throw replay.error
  return replay.result ?? { type: "void" }
}

function cache(
  queue: OwnerQueue,
  commandId: string,
  entry: { fingerprint: string; result?: BrowserBackendResult; error?: unknown; bytes: number },
): void {
  queue.results.set(commandId, entry)
  queue.resultBytes += entry.bytes
  while (queue.results.size > MAX_REPLAY_RESULTS || queue.resultBytes > MAX_REPLAY_BYTES) {
    const oldest = queue.results.keys().next().value
    if (typeof oldest !== "string") break
    queue.resultBytes -= queue.results.get(oldest)?.bytes ?? 0
    queue.results.delete(oldest)
  }
}

function encodedBytes(value: unknown): number {
  if (value instanceof Error) return Buffer.byteLength(`${value.name}:${value.message}`, "utf8")
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return 1_024
  }
}

function recordCommandFailureTelemetry(owner: BrowserOwner.Info, command: BrowserBackendCommand, error: unknown): void {
  if (!(error instanceof BrowserProtocolError)) {
    ObservabilityBrowserTelemetry.recordCommandFailure(owner, command, "browser_command_failed")
    return
  }
  ObservabilityBrowserTelemetry.recordCommandFailure(owner, command, error.code, error.obstruction?.candidates?.length)
}

function normalizeCommandError(error: unknown, commandId: string): unknown {
  if (error instanceof BrowserProtocolError) {
    if (error.commandId) return error
    const { type: _type, ...data } = error.toJSON()
    return new BrowserProtocolError({ ...data, commandId }, { cause: error })
  }
  return new BrowserProtocolError(
    {
      code: "browser_command_failed",
      message: error instanceof Error ? error.message : "Browser command failed.",
      retryable: false,
      commandId,
    },
    { cause: error },
  )
}
async function executeOnce(
  owner: BrowserOwner.Info,
  command: BrowserBackendCommand,
  request: ExecuteRequest,
): Promise<BrowserBackendResult> {
  const session = await BrowserCommandService.session(owner)
  throwIfAborted(request.signal, request.commandId)

  const descriptor = session.pages.find((page) => page.id === request.pageId)
  if (!descriptor)
    throw new BrowserProtocolError({
      code: "browser_page_missing",
      message: "Page not found. List pages to choose an available pageId.",
      retryable: false,
      pageId: request.pageId,
    })
  if (command.type === "close") {
    await session.closePage(request.pageId)
    return { type: "void" }
  }
  const profile = await BrowserProfiles.requireEnabled(descriptor.profileId)
  const url = command.type === "navigate" ? normalizeBrowserURL(command.url) : descriptor.url
  if (command.type === "navigate") authorizeNavigation(owner, url)
  await request.authorize?.({ profileId: profile.id, url, command })
  const current = await BrowserProfiles.requireEnabled(profile.id)
  if (current.revision !== profile.revision)
    throw new BrowserProtocolError({
      code: "browser_permission_changed",
      message: "Browser permissions changed. Review the page before continuing.",
      retryable: true,
      pageId: request.pageId,
    })
  throwIfAborted(request.signal, request.commandId)
  if (command.type === "resume") {
    const page = await session.resumePage(request.pageId)
    return { type: "page", page: pageState(page) }
  }
  const page = session.getPage(request.pageId)
  if (!page)
    throw new BrowserProtocolError({
      code: "browser_page_suspended",
      message: "Resume this page before using it.",
      retryable: true,
      pageId: request.pageId,
    })
  if (command.type !== "navigate" && page.url !== descriptor.url)
    throw new BrowserProtocolError({
      code: "browser_page_changed",
      message: "The page changed while awaiting permission. Inspect it before continuing.",
      retryable: true,
      pageId: page.id,
    })
  const result = await executePage(page, command.type === "navigate" ? { ...command, url } : command, request)
  await session.save()
  await session.notifyPageNavigated(page)
  return result
}

async function executePage(
  page: import("./page.js").BrowserPageBackend,
  command: BrowserBackendCommand,
  request: ExecuteRequest,
): Promise<BrowserBackendResult> {
  let aborted = false
  const onAbort = () => {
    aborted = true
    if (
      command.type === "navigate" ||
      command.type === "reload" ||
      command.type === "wait" ||
      command.type === "action" ||
      command.type === "history"
    ) {
      void page.execute({ type: "stop" }).catch(() => undefined)
    }
  }
  request.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const result = await page.execute(command)
    if (aborted || request.signal?.aborted) throwIfAborted(request.signal, request.commandId)
    return result
  } finally {
    request.signal?.removeEventListener("abort", onAbort)
  }
}

function authorizeNavigation(owner: BrowserOwner.Info, url: string): void {
  const decision = BrowserPolicy.hardCheckNavigation(url, owner.directory)
  if (decision.decision === "allow") return
  throw new BrowserProtocolError({
    code: "browser_navigation_denied",
    message: `Navigation denied: ${decision.reason}`,
    retryable: false,
    url,
  })
}

function pageState(page: import("./page.js").BrowserPageBackend) {
  return {
    id: page.id,
    url: page.url,
    title: page.title,
    isLoading: page.loading,
    lastActiveAt: page.lastActiveAt,
  }
}

function throwIfAborted(signal: AbortSignal | undefined, commandId: string): void {
  if (!signal?.aborted) return
  throw new BrowserProtocolError({
    code: "browser_command_aborted",
    message: "Browser command was cancelled.",
    retryable: true,
    commandId,
  })
}

export function registerBrowserCommands() {
  registerBrowserCommandExecutor({
    disposeOwner: BrowserCommandService.disposeOwner,
    clear: BrowserCommandService.clear,
  })
}
