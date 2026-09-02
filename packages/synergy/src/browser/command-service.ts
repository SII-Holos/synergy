import {
  BrowserBackendCommandSchema,
  BrowserProtocolError,
  normalizeBrowserURL,
  type BrowserBackendCommand,
  type BrowserBackendResult,
} from "@ericsanchezok/synergy-browser"
import { BrowserOwner } from "./owner.js"
import { BrowserPolicy } from "./policy.js"
import { BrowserRuntime, registerBrowserCommandExecutor } from "./runtime.js"
import type { BrowserSession } from "./types.js"
import { ObservabilityBrowserTelemetry } from "../observability/browser-metrics.js"
import { Log } from "../util/log.js"

interface ExecuteRequest {
  commandId: string
  command: BrowserBackendCommand
  signal?: AbortSignal
}

interface OwnerQueue {
  tail: Promise<void>
  results: Map<string, { fingerprint: string; result?: BrowserBackendResult; error?: unknown; bytes: number }>
  resultBytes: number
  closing: boolean
  suspending: boolean
}

interface IdleState {
  generation: number
  failures: number
  timer?: ReturnType<typeof setTimeout>
}

const MAX_REPLAY_RESULTS = 256
const MAX_REPLAY_BYTES = 128 * 1024 * 1024
const MAX_IDLE_SUSPEND_RETRIES = 3
const DEFAULT_OWNER_IDLE_MS = 10 * 60 * 1_000
const queues = new Map<string, OwnerQueue>()
const idleStates = new Map<string, IdleState>()
const log = Log.create({ service: "browser.command" })
let runtime: Pick<typeof BrowserRuntime, "getOrCreateSession"> = BrowserRuntime
let ownerIdleMs = DEFAULT_OWNER_IDLE_MS

export namespace BrowserCommandService {
  export async function session(owner: BrowserOwner.Info): Promise<BrowserSession> {
    return runtime.getOrCreateSession(owner)
  }

  export async function execute(owner: BrowserOwner.Info, request: ExecuteRequest): Promise<BrowserBackendResult> {
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
    const fingerprint = JSON.stringify(command)
    const key = BrowserOwner.key(owner)
    const queue = queues.get(key) ?? createQueue()
    queues.set(key, queue)
    if (queue.closing) {
      throw new BrowserProtocolError({
        code: "browser_session_closing",
        message: "The Browser session is closing and cannot accept new commands.",
        retryable: true,
        commandId: request.commandId,
      })
    }
    const restoreAfterIdleSuspension = queue.suspending && requiresExistingPage(command)
    const idleGeneration = owner.mode === "session" ? beginIdleActivity(key) : 0
    const replay = queue.results.get(request.commandId)
    if (replay) {
      try {
        const result = replayResult(replay, fingerprint, request.commandId)
        settleIdleActivity(owner, command.type, idleGeneration, true)
        return result
      } catch (error) {
        settleIdleActivity(owner, command.type, idleGeneration, false)
        throw error
      }
    }

    const run = queue.tail.then(async () => {
      throwIfAborted(request.signal, request.commandId)
      const repeated = queue.results.get(request.commandId)
      if (repeated) return replayResult(repeated, fingerprint, request.commandId)
      if (restoreAfterIdleSuspension) {
        const session = await BrowserCommandService.session(owner)
        if (!session.page && session.descriptor && (session.status === "suspended" || session.status === "failed")) {
          await session.resumePage()
        }
      }
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
    const settled = run.then(
      (result) => {
        settleIdleActivity(owner, command.type, idleGeneration, true)
        return result
      },
      (error) => {
        settleIdleActivity(owner, command.type, idleGeneration, false)
        throw error
      },
    )
    queue.tail = settled.then(
      () => undefined,
      () => undefined,
    )
    return settled
  }

  export function clear(): void {
    for (const state of idleStates.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    idleStates.clear()
    queues.clear()
  }

  export async function disposeOwner(owner: BrowserOwner.Info, dispose: () => Promise<void>): Promise<void> {
    const key = BrowserOwner.key(owner)
    clearIdleState(key)
    const queue = queues.get(key) ?? createQueue()
    queues.set(key, queue)
    queue.closing = true
    const operation = queue.tail.then(dispose)
    queue.tail = operation.then(
      () => undefined,
      () => undefined,
    )
    try {
      await operation
    } finally {
      if (queues.get(key) === queue) queues.delete(key)
    }
  }

  export function useRuntimeForTest(
    adapter: Pick<typeof BrowserRuntime, "getOrCreateSession">,
    options?: { ownerIdleMs?: number },
  ): () => void {
    const previous = runtime
    const previousIdleMs = ownerIdleMs
    runtime = adapter
    ownerIdleMs = options?.ownerIdleMs ?? DEFAULT_OWNER_IDLE_MS
    return () => {
      runtime = previous
      ownerIdleMs = previousIdleMs
      clear()
    }
  }
}

function settleIdleActivity(
  owner: BrowserOwner.Info,
  commandType: BrowserBackendCommand["type"],
  generation: number,
  succeeded: boolean,
): void {
  if (commandType === "close" && succeeded) {
    clearIdleGeneration(BrowserOwner.key(owner), generation)
    return
  }
  scheduleIdleSuspension(owner, generation)
}

function beginIdleActivity(key: string): number {
  const state = idleStates.get(key) ?? { generation: 0, failures: 0 }
  if (state.timer) clearTimeout(state.timer)
  state.timer = undefined
  state.generation++
  state.failures = 0
  idleStates.set(key, state)
  return state.generation
}
function clearIdleGeneration(key: string, generation: number): void {
  const state = idleStates.get(key)
  if (!state || state.generation !== generation) return
  if (state.timer) clearTimeout(state.timer)
  idleStates.delete(key)
}

function scheduleIdleSuspension(owner: BrowserOwner.Info, generation: number): void {
  if (ownerIdleMs <= 0 || owner.mode !== "session") return
  const key = BrowserOwner.key(owner)
  const state = idleStates.get(key)
  if (!state || state.generation !== generation) return
  if (state.timer) clearTimeout(state.timer)
  const timer = setTimeout(() => {
    if (state.timer === timer) state.timer = undefined
    void suspendIdleOwner(owner, generation)
  }, ownerIdleMs)
  const unref = (timer as { unref?: () => void }).unref
  unref?.call(timer)
  state.timer = timer
}

async function suspendIdleOwner(owner: BrowserOwner.Info, generation: number): Promise<void> {
  const key = BrowserOwner.key(owner)
  const state = idleStates.get(key)
  if (!state || state.generation !== generation) return
  const queue = queues.get(key) ?? createQueue()
  queues.set(key, queue)
  const operation = queue.tail.then(async () => {
    if (idleStates.get(key)?.generation !== generation) return false
    const session = await runtime.getOrCreateSession(owner)
    if (idleStates.get(key)?.generation !== generation) return false
    if (session.page?.backend === "host") return true
    queue.suspending = true
    try {
      await session.suspend()
    } finally {
      queue.suspending = false
    }
    return true
  })
  queue.tail = operation.then(
    () => undefined,
    () => undefined,
  )
  try {
    const handled = await operation
    if (handled && idleStates.get(key)?.generation === generation) idleStates.delete(key)
  } catch (error) {
    if (idleStates.get(key)?.generation !== generation) return
    state.failures++
    if (state.failures <= MAX_IDLE_SUSPEND_RETRIES) {
      scheduleIdleSuspension(owner, generation)
    } else {
      idleStates.delete(key)
      log.warn("failed to suspend idle browser owner after retries", { ownerMode: owner.mode, error })
    }
  }
}

function clearIdleState(key: string): void {
  const state = idleStates.get(key)
  if (state?.timer) clearTimeout(state.timer)
  idleStates.delete(key)
}

function createQueue(): OwnerQueue {
  return {
    tail: Promise.resolve(),
    results: new Map(),
    resultBytes: 0,
    closing: false,
    suspending: false,
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

  if (command.type === "close") {
    await session.closePage()
    return { type: "void" }
  }

  if (command.type === "navigate") {
    const url = normalizeBrowserURL(command.url)
    authorizeNavigation(owner, url)
    // A page whose Host died is still referenced by the session but no longer
    // alive; ensurePage closes it and recreates it against the reconnected
    // Host instead of reusing the dead backend (which would keep rejecting
    // commands through the restarting gate).
    const page =
      session.page && session.page.isAlive() ? session.page : await session.ensurePage(undefined, { resume: false })
    const result = await executePage(page, { ...command, url }, request)
    await session.save({ captureCheckpoint: true })
    await session.notifyPageNavigated(page)
    return result
  }

  if (command.type === "resume") {
    const page = await session.resumePage()
    return { type: "page", page: pageState(page) }
  }

  if (!session.page) {
    throw new BrowserProtocolError({
      code: session.status === "suspended" ? "browser_page_suspended" : "browser_page_missing",
      message:
        session.status === "suspended"
          ? "The browser page is suspended. Resume it before issuing this command."
          : "No browser page is open.",
      retryable: session.status === "suspended",
      commandId: request.commandId,
      pageId: session.descriptor?.id,
      url: session.descriptor?.url,
      suggestedAction:
        session.status === "suspended"
          ? "Use browser_navigation with action resume."
          : "Use browser_navigation with action goto.",
    })
  }
  const page = await session.ensurePage(undefined, { resume: false })
  const result = await executePage(page, command, request)
  if (shouldCheckpoint(command)) await session.save({ captureCheckpoint: true })
  return result
}

async function executePage(
  page: NonNullable<BrowserSession["page"]>,
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

function requiresExistingPage(command: BrowserBackendCommand): boolean {
  return command.type !== "close" && command.type !== "navigate" && command.type !== "resume"
}

function shouldCheckpoint(command: BrowserBackendCommand): boolean {
  if (command.type === "action" || command.type === "emulate" || command.type === "upload") return true
  if (command.type === "evaluate") return command.mode === "trusted"
  if (command.type === "dialog") return command.action !== "status"
  if (command.type === "clipboard") return command.action !== "read"
  return command.type === "history" || command.type === "reload" || command.type === "setViewport"
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

function pageState(page: NonNullable<BrowserSession["page"]>) {
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

registerBrowserCommandExecutor({
  disposeOwner: BrowserCommandService.disposeOwner,
  clear: BrowserCommandService.clear,
})
