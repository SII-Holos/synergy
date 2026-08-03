import {
  BROWSER_PROTOCOL_VERSION,
  BrowserProtocolError,
  type BrowserNativePresentationCapabilityResult,
  type BrowserNativePresentationIPCError,
} from "@ericsanchezok/synergy-browser"
import type { BrowserNativeViewBridge } from "@/context/platform"

const FAST_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const
const FAST_RETRY_WINDOW_MS = 30_000
const SLOW_RETRY_DELAY_MS = 30_000

export type BrowserClientPresentationMode = "native" | "webrtc"
export type NativePresentationRecoveryState = {
  phase: "recovering" | "ready" | "failed"
  error?: BrowserNativePresentationIPCError
}

export async function resolveBrowserClientPresentation(input: {
  bridge?: BrowserNativeViewBridge
  serverUrl: string
}): Promise<BrowserClientPresentationMode> {
  if (!input.bridge) return "webrtc"
  try {
    const capability = await input.bridge.presentationCapability({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      serverUrl: input.serverUrl,
    })
    return capability.managedLocal ? "native" : "webrtc"
  } catch {
    return "native"
  }
}

export class NativePresentationCoordinator {
  private disposed = false
  private retryEpoch = 0
  private ticketTail: Promise<unknown> = Promise.resolve()
  private wakeDelay: (() => void) | null = null

  constructor(
    private readonly input: {
      bridge: BrowserNativeViewBridge
      serverUrl: string
      ownerKey: string
      onState(state: NativePresentationRecoveryState): void
      now?: () => number
      delay?: (milliseconds: number) => Promise<void>
    },
  ) {}

  createTicket(): Promise<string> {
    const operation = this.ticketTail.then(() => this.issueWithRecovery())
    this.ticketTail = operation.catch(() => undefined)
    return operation
  }

  retry(): void {
    this.retryEpoch++
    this.wakeDelay?.()
    this.wakeDelay = null
  }

  dispose(): void {
    this.disposed = true
    this.retry()
  }

  private async issueWithRecovery(): Promise<string> {
    let startedAt = this.now()
    let observedRetryEpoch = this.retryEpoch
    let attempt = 0
    let lastError: BrowserNativePresentationIPCError | undefined
    while (!this.disposed) {
      const capability = await this.capability()
      if (!capability.managedLocal) {
        throw this.protocolError(
          capability.error ?? {
            code: "browser_native_origin_mismatch",
            message: "The connected server is not owned by this Desktop Browser Host.",
            retryable: true,
          },
        )
      }
      if (capability.status === "ready") {
        const issued = await this.input.bridge.createPresentationTicket({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          serverUrl: this.input.serverUrl,
          ownerKey: this.input.ownerKey,
        })
        if (issued.ok) {
          this.input.onState({ phase: "ready" })
          return issued.ticket
        }
        lastError = issued.error
        if (!issued.error.retryable) throw this.protocolError(issued.error)
      } else {
        lastError =
          capability.error ??
          ({
            code: "browser_native_host_connecting",
            message: "The Desktop Browser Host is still connecting.",
            retryable: true,
          } satisfies BrowserNativePresentationIPCError)
      }

      const elapsed = this.now() - startedAt
      const slow = elapsed >= FAST_RETRY_WINDOW_MS
      this.input.onState({ phase: slow ? "failed" : "recovering", error: lastError })
      const retryDelay = slow
        ? SLOW_RETRY_DELAY_MS
        : FAST_RETRY_DELAYS_MS[Math.min(attempt++, FAST_RETRY_DELAYS_MS.length - 1)]
      await this.wait(retryDelay)
      if (observedRetryEpoch !== this.retryEpoch) {
        observedRetryEpoch = this.retryEpoch
        attempt = 0
        startedAt = this.now()
      }
    }
    throw new BrowserProtocolError({
      code: "browser_native_ticket_rejected",
      message: "Native Browser presentation recovery was cancelled.",
      retryable: true,
    })
  }

  private async capability(): Promise<BrowserNativePresentationCapabilityResult> {
    try {
      return await this.input.bridge.presentationCapability({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        serverUrl: this.input.serverUrl,
      })
    } catch {
      return {
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        managedLocal: true,
        status: "failed",
        error: {
          code: "browser_native_bridge_missing",
          message: "The Desktop native Browser bridge is unavailable.",
          retryable: true,
        },
      }
    }
  }

  private protocolError(error: BrowserNativePresentationIPCError): BrowserProtocolError {
    return new BrowserProtocolError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      suggestedAction: "Retry native Browser recovery.",
    })
  }

  private now(): number {
    return this.input.now?.() ?? Date.now()
  }

  private async wait(milliseconds: number): Promise<void> {
    if (this.input.delay) {
      await this.input.delay(milliseconds)
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, milliseconds)
      const coordinator = this
      function finish() {
        clearTimeout(timer)
        if (coordinator.wakeDelay === finish) coordinator.wakeDelay = null
        resolve()
      }
      this.wakeDelay = finish
    })
  }
}
