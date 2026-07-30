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
    readonly code: "capacity" | "conflict",
    message: string,
  ) {
    super(message)
    this.name = "PluginAgentCallRuntimeError"
  }
}

export class PluginAgentCallRuntime {
  readonly #activeById = new Map<string, ActiveCall>()
  readonly #activeByCorrelation = new Map<string, ActiveCall>()

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

  cancelGeneration(pluginId: string, pluginGeneration: string, reason = "Plugin generation stopped"): void {
    for (const call of this.#activeById.values()) {
      if (call.pluginId !== pluginId || call.pluginGeneration !== pluginGeneration) continue
      call.controller.abort(new DOMException(reason, "AbortError"))
      void this.settle(call, call.deliver, {
        status: "cancelled",
        error: {
          code: "PLUGIN_AGENT_CANCELLED",
          message: reason,
        },
      })
    }
  }

  activeCount(pluginId?: string): number {
    if (!pluginId) return this.#activeById.size
    return [...this.#activeById.values()].filter((call) => call.pluginId === pluginId).length
  }

  private correlationKey(input: { pluginId: string; scopeId: string; correlationId: string }): string {
    return [input.pluginId, input.scopeId, input.correlationId].join("\u0000")
  }

  private async settle(
    call: ActiveCall,
    deliver: (call: PluginAgentCallTerminal) => Promise<void>,
    terminal: Pick<PluginAgentCallTerminal, "status" | "text" | "error">,
  ): Promise<void> {
    if (this.#activeById.get(call.callId) !== call) return
    this.#activeById.delete(call.callId)
    this.#activeByCorrelation.delete(call.key)
    await deliver({
      callId: call.callId,
      correlationId: call.correlationId,
      status: terminal.status,
      ...(terminal.text === undefined ? {} : { text: terminal.text }),
      ...(terminal.error === undefined ? {} : { error: terminal.error }),
      startedAt: call.startedAt,
      completedAt: Date.now(),
    }).catch(() => undefined)
  }
}

export const pluginAgentCallRuntime = new PluginAgentCallRuntime()
