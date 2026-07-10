import {
  BrowserBackendCommandSchema,
  BrowserProtocolError,
  normalizeBrowserURL,
  type BrowserBackendCommand,
  type BrowserBackendResult,
} from "@ericsanchezok/synergy-browser"
import { BrowserOwner } from "./owner.js"
import { BrowserPolicy } from "./policy.js"
import { BrowserRuntime } from "./runtime.js"
import { BlockedURLNavigationError } from "./page.js"
import type { BrowserSession } from "./types.js"
import { BrowserNetworkGateway } from "./network-gateway.js"
import type { BrowserPrivateNetworkGrant } from "./network-gateway.js"

interface ExecuteRequest {
  commandId: string
  command: BrowserBackendCommand
  signal?: AbortSignal
  navigationGrant?: string
  privateNetworkGrant?: BrowserPrivateNetworkGrant
}

interface OwnerQueue {
  tail: Promise<void>
  results: Map<string, { fingerprint: string; result?: BrowserBackendResult; error?: unknown; bytes: number }>
  resultBytes: number
  closing: boolean
}

const MAX_REPLAY_RESULTS = 256
const MAX_REPLAY_BYTES = 128 * 1024 * 1024
const queues = new Map<string, OwnerQueue>()
let runtime: Pick<typeof BrowserRuntime, "getOrCreateSession"> = BrowserRuntime

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
    const queue = queues.get(key) ?? { tail: Promise.resolve(), results: new Map(), resultBytes: 0, closing: false }
    queues.set(key, queue)
    if (queue.closing) {
      throw new BrowserProtocolError({
        code: "browser_session_closing",
        message: "The Browser session is closing and cannot accept new commands.",
        retryable: true,
        commandId: request.commandId,
      })
    }
    const replay = queue.results.get(request.commandId)
    if (replay) return replayResult(replay, fingerprint, request.commandId)

    const run = queue.tail.then(async () => {
      throwIfAborted(request.signal, request.commandId)
      const repeated = queue.results.get(request.commandId)
      if (repeated) return replayResult(repeated, fingerprint, request.commandId)
      try {
        const result = await executeOnce(owner, command, request)
        cache(queue, request.commandId, { fingerprint, result, bytes: encodedBytes(result) })
        return result
      } catch (error) {
        const normalized = normalizeCommandError(error, request.commandId)
        cache(queue, request.commandId, { fingerprint, error: normalized, bytes: encodedBytes(normalized) })
        throw normalized
      }
    })
    queue.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  export function clear(): void {
    queues.clear()
  }

  export async function disposeOwner(owner: BrowserOwner.Info, dispose: () => Promise<void>): Promise<void> {
    const key = BrowserOwner.key(owner)
    const queue = queues.get(key) ?? { tail: Promise.resolve(), results: new Map(), resultBytes: 0, closing: false }
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

  export function useRuntimeForTest(adapter: Pick<typeof BrowserRuntime, "getOrCreateSession">): () => void {
    const previous = runtime
    runtime = adapter
    return () => {
      runtime = previous
      queues.clear()
    }
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

function normalizeCommandError(error: unknown, commandId: string): unknown {
  if (error instanceof BlockedURLNavigationError) return error
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
    authorizeNavigation(owner, url, command.source, request.navigationGrant)
    if (request.privateNetworkGrant) BrowserNetworkGateway.allowPrivateNetwork(owner, request.privateNetworkGrant)
    const page = session.page ?? (await session.ensurePage(undefined, { resume: false }))
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
    if (command.type === "navigate" || command.type === "reload" || command.type === "wait") {
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

function shouldCheckpoint(command: BrowserBackendCommand): boolean {
  if (command.type === "action" || command.type === "emulate" || command.type === "upload") return true
  if (command.type === "evaluate") return command.mode === "trusted"
  if (command.type === "dialog") return command.action !== "status"
  if (command.type === "clipboard") return command.action !== "read"
  return command.type === "history" || command.type === "reload" || command.type === "setViewport"
}

function authorizeNavigation(
  owner: BrowserOwner.Info,
  url: string,
  source: "agent" | "user",
  navigationGrant?: string,
): void {
  const decision =
    source === "user"
      ? BrowserPolicy.hardCheckNavigation(url, owner.directory)
      : BrowserPolicy.evaluateURL(url, owner.directory)
  if (decision.decision === "allow") return
  if (decision.decision === "blocked" && source === "agent" && navigationGrant === url) return
  if (decision.decision === "blocked") throw new BlockedURLNavigationError(decision.reason, url)
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
