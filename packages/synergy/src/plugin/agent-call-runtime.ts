import { Log } from "../util/log"
export type PluginAgentCallTerminal = {
  callId: string
  correlationId: string
  status: "completed" | "error" | "cancelled"
  text?: string
  error?: {
    code: string
    message: string
  }
  startedAt: number
  completedAt: number
}

type ActiveCall = {
  callId: string
  key: string
  pluginId: string
  pluginGeneration: string
  scopeId: string
  correlationId: string
  inputDigest: string
  controller: AbortController
  startedAt: number
  deliver(call: PluginAgentCallTerminal): Promise<void>
}

export class PluginAgentCallRuntimeError extends Error {
  constructor(
    readonly code: "capacity" | "conflict" | "cancelled",
    message: string,
  ) {
    super(message)
    this.name = "PluginAgentCallRuntimeError"
  }
}

const log = Log.create({ service: "plugin.agent-call" })

export type PluginAgentCallDeliveryStatus = "rejected" | "plugin_mismatch" | "no_handler" | "failed"

const DELIVERY_ERROR_SUMMARIES: Record<PluginAgentCallDeliveryStatus, string> = {
  rejected: "delivery_rejected",
  plugin_mismatch: "plugin_generation_inactive",
  no_handler: "hook_handler_missing",
  failed: "hook_handler_failed",
}

export function pluginAgentCallDeliveryErrorSummary(status: PluginAgentCallDeliveryStatus): string {
  return DELIVERY_ERROR_SUMMARIES[status]
}

export function warnPluginAgentCallDelivery(input: {
  pluginId: string
  generation: string
  scopeId: string
  callId: string
  terminalStatus: PluginAgentCallTerminal["status"]
  deliveryStatus: PluginAgentCallDeliveryStatus
  handlerCount?: number
  succeededHandlerCount?: number
}): void {
  log.warn(
    input.deliveryStatus === "rejected"
      ? "plugin Agent call terminal delivery rejected"
      : "plugin Agent call terminal delivery was not acknowledged",
    {
      pluginId: input.pluginId,
      generation: input.generation,
      scopeId: input.scopeId,
      callId: input.callId,
      terminalStatus: input.terminalStatus,
      deliveryStatus: input.deliveryStatus,
      ...(input.handlerCount === undefined ? {} : { handlerCount: input.handlerCount }),
      ...(input.succeededHandlerCount === undefined ? {} : { succeededHandlerCount: input.succeededHandlerCount }),
      errorSummary: pluginAgentCallDeliveryErrorSummary(input.deliveryStatus),
    },
  )
}

export class PluginAgentCallRuntime {
  readonly #activeById = new Map<string, ActiveCall>()
  readonly #activeByCorrelation = new Map<string, ActiveCall>()
  readonly #disabledScopes = new Set<string>()

  constructor(readonly maxConcurrentPerPlugin = 4) {}

  start(input: {
    pluginId: string
    pluginGeneration: string
    scopeId: string
    correlationId: string
    inputDigest: string
    run(signal: AbortSignal): Promise<{ text: string }>
    deliver(call: PluginAgentCallTerminal): Promise<void>
    mapError(error: unknown): { code: string; message: string }
  }): { callId: string } {
    if (this.#disabledScopes.has(input.scopeId)) {
      throw new PluginAgentCallRuntimeError("cancelled", `Scope ${input.scopeId} is not accepting Agent calls`)
    }
    const key = this.correlationKey(input)
    const existing = this.#activeByCorrelation.get(key)
    if (existing) {
      if (existing.inputDigest !== input.inputDigest) {
        throw new PluginAgentCallRuntimeError(
          "conflict",
          `An active Agent call already uses correlationId "${input.correlationId}" with different input`,
        )
      }
      return { callId: existing.callId }
    }

    const pluginCount = [...this.#activeById.values()].filter((call) => call.pluginId === input.pluginId).length
    if (pluginCount >= this.maxConcurrentPerPlugin) {
      throw new PluginAgentCallRuntimeError(
        "capacity",
        `Plugin ${input.pluginId} already has ${this.maxConcurrentPerPlugin} active Agent calls`,
      )
    }

    const call: ActiveCall = {
      callId: crypto.randomUUID(),
      key,
      pluginId: input.pluginId,
      pluginGeneration: input.pluginGeneration,
      scopeId: input.scopeId,
      correlationId: input.correlationId,
      inputDigest: input.inputDigest,
      controller: new AbortController(),
      startedAt: Date.now(),
      deliver: input.deliver,
    }
    this.#activeById.set(call.callId, call)
    this.#activeByCorrelation.set(call.key, call)

    void Promise.resolve()
      .then(() => input.run(call.controller.signal))
      .then(
        (result) =>
          this.settle(call, input.deliver, {
            status: "completed",
            text: result.text,
          }),
        (error) => {
          const mapped = input.mapError(error)
          return this.settle(call, input.deliver, {
            status: call.controller.signal.aborted ? "cancelled" : "error",
            error: mapped,
          })
        },
      )
      .catch(() => undefined)

    return { callId: call.callId }
  }

  cancelGeneration(pluginId: string, pluginGeneration: string, reason = "Plugin generation stopped"): Promise<void> {
    return this.cancelMatching(
      (call) => call.pluginId === pluginId && call.pluginGeneration === pluginGeneration,
      reason,
    )
  }

  disableScope(scopeId: string, reason = "Scope runtime disposed"): Promise<void> {
    this.#disabledScopes.add(scopeId)
    return this.cancelMatching((call) => call.scopeId === scopeId, reason)
  }

  enableScope(scopeId: string): void {
    this.#disabledScopes.delete(scopeId)
  }

  activeCount(pluginId?: string): number {
    if (!pluginId) return this.#activeById.size
    return [...this.#activeById.values()].filter((call) => call.pluginId === pluginId).length
  }

  private correlationKey(input: { pluginId: string; scopeId: string; correlationId: string }): string {
    return [input.pluginId, input.scopeId, input.correlationId].join("\u0000")
  }

  private cancelMatching(predicate: (call: ActiveCall) => boolean, reason: string): Promise<void> {
    const deliveries: Promise<void>[] = []
    for (const call of [...this.#activeById.values()]) {
      if (!predicate(call) || !this.claim(call)) continue
      call.controller.abort(new DOMException(reason, "AbortError"))
      deliveries.push(
        this.deliver(call, {
          status: "cancelled",
          error: {
            code: "PLUGIN_AGENT_CANCELLED",
            message: reason,
          },
        }),
      )
    }
    return Promise.all(deliveries).then(() => undefined)
  }

  private claim(call: ActiveCall): boolean {
    if (this.#activeById.get(call.callId) !== call) return false
    this.#activeById.delete(call.callId)
    this.#activeByCorrelation.delete(call.key)
    return true
  }

  private async settle(
    call: ActiveCall,
    _deliver: (call: PluginAgentCallTerminal) => Promise<void>,
    terminal: Pick<PluginAgentCallTerminal, "status" | "text" | "error">,
  ): Promise<void> {
    if (!this.claim(call)) return
    await this.deliver(call, terminal)
  }

  private async deliver(
    call: ActiveCall,
    terminal: Pick<PluginAgentCallTerminal, "status" | "text" | "error">,
  ): Promise<void> {
    const delivered = {
      callId: call.callId,
      correlationId: call.correlationId,
      status: terminal.status,
      ...(terminal.text === undefined ? {} : { text: terminal.text }),
      ...(terminal.error === undefined ? {} : { error: terminal.error }),
      startedAt: call.startedAt,
      completedAt: Date.now(),
    }
    try {
      await call.deliver(delivered)
    } catch {
      warnPluginAgentCallDelivery({
        pluginId: call.pluginId,
        generation: call.pluginGeneration,
        scopeId: call.scopeId,
        callId: call.callId,
        terminalStatus: terminal.status,
        deliveryStatus: "rejected",
      })
    }
  }
}

export const pluginAgentCallRuntime = new PluginAgentCallRuntime()
